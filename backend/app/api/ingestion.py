"""
Webhooks (real-time updates from vendors) and lead ingestion.
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.adapters import get_adapter
from app.config import get_settings
from app.database import get_db
from app.models import Lead
from app.schemas import PushRecipientsRequest, TriggerCampaignRequest, TriggerCampaignResponse
from app.services.sheets import import_sheet
from app.services.upsert import ensure_campaign, get_vendor_by_slug, upsert_call

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api", tags=["ingestion"])


# ---------------------------------------------------------------------------
# Hunar webhooks. We accept all event types on a single path and dispatch
# inside the adapter.
# ---------------------------------------------------------------------------
@router.post("/webhooks/hunar/{event_kind}")
async def hunar_webhook(event_kind: str, payload: dict[str, Any], db: AsyncSession = Depends(get_db)):
    adapter = get_adapter("hunar")
    vendor = await get_vendor_by_slug(db, "hunar")
    if not vendor:
        raise HTTPException(status_code=500, detail="Hunar vendor not seeded in DB")

    normalized = adapter.parse_webhook(payload)
    if normalized:
        await upsert_call(db, vendor.id, normalized)
        await db.commit()
        return {"status": "applied"}

    # For thin events that don't carry full state, fetch authoritative version.
    call_id = payload.get("call_id")
    if call_id:
        latest = await adapter.get_call(call_id)
        if latest:
            await upsert_call(db, vendor.id, latest)
            await db.commit()
            return {"status": "fetched_and_applied"}

    return {"status": "ignored", "event_kind": event_kind}


# ---------------------------------------------------------------------------
# Sheets import (manual trigger / cron)
# ---------------------------------------------------------------------------
class SheetImportRequest(BaseModel):
    sheet_id: str
    worksheet_name: str | None = None


@router.post("/ingest/google-sheets")
async def trigger_sheet_import(req: SheetImportRequest, db: AsyncSession = Depends(get_db)):
    try:
        result = await import_sheet(db, req.sheet_id, req.worksheet_name)
    except Exception as e:
        logger.exception("sheet import failed")
        raise HTTPException(status_code=500, detail=str(e))
    return result


# ---------------------------------------------------------------------------
# Push leads from Sheets into a vendor as a bulk campaign.
# Sheets row → vendor bulk_call → call_logs (via webhook + sync).
# ---------------------------------------------------------------------------
@router.post("/ingest/push-to-vendor", response_model=TriggerCampaignResponse)
async def push_leads_to_vendor(req: TriggerCampaignRequest, db: AsyncSession = Depends(get_db)):
    settings = get_settings()
    vendor = await get_vendor_by_slug(db, req.vendor_slug)
    if not vendor:
        raise HTTPException(status_code=404, detail=f"Vendor '{req.vendor_slug}' not found")

    # Step 1: pull leads from sheet. Capture cutoff BEFORE import so we can
    # fetch only the rows we just added (skipping prior duplicates).
    cutoff = datetime.now(timezone.utc)
    sheet_result = await import_sheet(db, req.sheet_id, req.worksheet_name)

    # Step 2: fetch the freshly-imported leads.
    sheet_prefix = f"sheet:{req.sheet_id}:row:"
    leads_stmt = (
        select(Lead)
        .where(
            Lead.source == "google_sheets",
            Lead.source_ref.like(f"{sheet_prefix}%"),
            Lead.ingested_at >= cutoff,
        )
        .order_by(Lead.ingested_at.asc())
    )
    if req.max_recipients:
        leads_stmt = leads_stmt.limit(req.max_recipients)

    leads = (await db.execute(leads_stmt)).scalars().all()
    if not leads:
        return TriggerCampaignResponse(
            status="no_recipients",
            request_id="",
            sheet_rows_inserted=sheet_result["rows_inserted"],
            recipients_pushed=0,
            warning="No new rows from sheet (likely all duplicates of existing leads).",
        )

    recipients = [
        {
            "callee_name": lead.name,
            "mobile_number": lead.mobile_number,
            "custom_data": {"lead_id": str(lead.id), "email": lead.email or "", **(lead.custom_data or {})},
        }
        for lead in leads
    ]

    # Step 3: hand off to the vendor adapter.
    adapter = get_adapter(req.vendor_slug)
    request_id = f"campaign_{uuid.uuid4().hex[:16]}"

    try:
        vendor_response = await adapter.create_bulk_calls(
            agent_id=req.vendor_agent_id,
            recipients=recipients,
            request_id=request_id,
            callback_base_url=settings.public_webhook_base_url,
        )
    except Exception as e:
        logger.exception("vendor bulk_calls failed")
        raise HTTPException(status_code=502, detail=f"Vendor rejected the request: {e}")

    # Step 4: pre-create our campaign row so the dashboard sees it immediately
    # (no waiting for the next sync to discover this request_id).
    await ensure_campaign(
        db,
        vendor_id=vendor.id,
        vendor_request_id=request_id,
        name=req.campaign_name or f"Sheets push {datetime.now().strftime('%Y-%m-%d %H:%M')}",
        started_at=datetime.now(timezone.utc),
    )
    await db.commit()

    return TriggerCampaignResponse(
        status="launched",
        request_id=request_id,
        sheet_rows_inserted=sheet_result["rows_inserted"],
        recipients_pushed=len(recipients),
        vendor_response=vendor_response if isinstance(vendor_response, dict) else {"raw": str(vendor_response)},
    )


# ---------------------------------------------------------------------------
# Push pre-parsed recipients (from CSV upload) directly to a vendor.
# Used by the dashboard's Launch Campaign page when the user uploads a CSV
# instead of pointing at a Google Sheet.
# ---------------------------------------------------------------------------
@router.post("/ingest/push-recipients", response_model=TriggerCampaignResponse)
async def push_recipients_to_vendor(req: PushRecipientsRequest, db: AsyncSession = Depends(get_db)):
    settings = get_settings()
    vendor = await get_vendor_by_slug(db, req.vendor_slug)
    if not vendor:
        raise HTTPException(status_code=404, detail=f"Vendor '{req.vendor_slug}' not found")
    if not req.recipients:
        raise HTTPException(status_code=400, detail="At least one recipient is required")

    recipients = [r.model_dump() for r in req.recipients]
    adapter = get_adapter(req.vendor_slug)
    request_id = f"campaign_{uuid.uuid4().hex[:16]}"

    try:
        vendor_response = await adapter.create_bulk_calls(
            agent_id=req.vendor_agent_id,
            recipients=recipients,
            request_id=request_id,
            callback_base_url=settings.public_webhook_base_url,
        )
    except Exception as e:
        logger.exception("vendor bulk_calls failed")
        raise HTTPException(status_code=502, detail=f"Vendor rejected the request: {e}")

    await ensure_campaign(
        db,
        vendor_id=vendor.id,
        vendor_request_id=request_id,
        name=req.campaign_name or f"CSV upload {datetime.now().strftime('%Y-%m-%d %H:%M')}",
        started_at=datetime.now(timezone.utc),
    )
    await db.commit()

    return TriggerCampaignResponse(
        status="launched",
        request_id=request_id,
        sheet_rows_inserted=0,
        recipients_pushed=len(recipients),
        vendor_response=vendor_response if isinstance(vendor_response, dict) else {"raw": str(vendor_response)},
    )
