"""CSV export endpoints."""
from __future__ import annotations

import csv
import io

from fastapi import APIRouter, Depends, Query
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api._filters import parse_filters
from app.database import get_db
from app.models import Campaign, CallLog, Vendor
from app.services.metrics import MetricFilters

router = APIRouter(prefix="/api/export", tags=["export"])


CSV_FIELDS = [
    "call_id", "vendor", "campaign", "callee_name", "mobile_number",
    "status", "lifecycle_status", "engagement_status", "answered_by", "call_ended_by",
    "duration_seconds", "duration_minutes", "retry_count", "max_retries",
    "started_at", "ended_at", "recording_url", "result_json",
]


@router.get("/calls.csv")
async def export_calls(
    filters: MetricFilters = Depends(parse_filters),
    funnel_stage: str | None = Query(None, description="connected | engaged | interested | followup"),
    db: AsyncSession = Depends(get_db),
):
    from sqlalchemy import and_, func
    stmt = (
        select(CallLog, Vendor.name.label("vendor_name"), Campaign.name.label("campaign_name"))
        .join(Vendor, Vendor.id == CallLog.vendor_id)
        .outerjoin(Campaign, Campaign.id == CallLog.campaign_id)
        .order_by(CallLog.started_at.desc().nullslast())
        .limit(50000)
    )
    stmt = filters.apply(stmt)

    # Optional funnel stage filter — matches calls.py logic exactly
    if funnel_stage:
        is_connected = and_(CallLog.lifecycle_status == "COMPLETED", CallLog.answered_by == "HUMAN")
        if funnel_stage == "connected":
            stmt = stmt.where(is_connected)
        elif funnel_stage == "engaged":
            stmt = stmt.where(and_(is_connected, CallLog.engagement_status == "ENGAGED"))
        elif funnel_stage == "interested":
            stmt = stmt.where(and_(
                is_connected,
                func.upper(CallLog.result["interest_level"].astext).in_(["HIGH", "MEDIUM"]),
            ))
        elif funnel_stage == "followup":
            stmt = stmt.where(and_(
                is_connected,
                func.upper(CallLog.result["next_step_interest"].astext) == "CALLBACK",
            ))

    async def gen():
        buf = io.StringIO()
        writer = csv.DictWriter(buf, fieldnames=CSV_FIELDS)
        writer.writeheader()
        yield buf.getvalue()
        buf.seek(0); buf.truncate()

        result = await db.execute(stmt)
        for row in result:
            call: CallLog = row[0]
            writer.writerow({
                "call_id": str(call.id),
                "vendor": row.vendor_name,
                "campaign": row.campaign_name or "",
                "callee_name": call.callee_name or "",
                "mobile_number": call.mobile_number or "",
                "status": call.status,
                "lifecycle_status": call.lifecycle_status,
                "engagement_status": call.engagement_status,
                "answered_by": call.answered_by,
                "call_ended_by": call.call_ended_by,
                "duration_seconds": call.duration_seconds or "",
                "duration_minutes": call.duration_minutes or "",
                "retry_count": call.retry_count,
                "max_retries": call.max_retries,
                "started_at": call.started_at.isoformat() if call.started_at else "",
                "ended_at": call.ended_at.isoformat() if call.ended_at else "",
                "recording_url": call.recording_url or "",
                "result_json": str(call.result),
            })
            yield buf.getvalue()
            buf.seek(0); buf.truncate()

    return StreamingResponse(
        gen(),
        media_type="text/csv",
        headers={"Content-Disposition": 'attachment; filename="calls.csv"'},
    )
