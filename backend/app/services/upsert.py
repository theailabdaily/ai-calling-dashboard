"""
Idempotent upserts. Sync jobs and webhook handlers both call into here.
"""
from __future__ import annotations

import logging
from datetime import datetime
from typing import Any
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.adapters.base import NormalizedAgent, NormalizedCall
from app.models import Agent, CallLog, Campaign, Vendor

logger = logging.getLogger(__name__)


# Hard exclusion list. Any call whose vendor_request_id matches an entry here is
# silently dropped by upsert_call — used to retire test/duplicate API submissions
# whose webhooks would otherwise keep resurrecting deleted rows.
EXCLUDED_VENDOR_REQUEST_IDS: set[str] = {
    "campaign_f81ddc0a4a32462d",  # 2026-05-02 — API push duplicated via Hunar UI campaign
}


async def get_vendor_by_slug(db: AsyncSession, slug: str) -> Vendor | None:
    res = await db.execute(select(Vendor).where(Vendor.slug == slug))
    return res.scalar_one_or_none()


# ---------------------------------------------------------------------------
# Agents
# ---------------------------------------------------------------------------
async def upsert_agent(db: AsyncSession, vendor_id: UUID, n: NormalizedAgent) -> UUID:
    stmt = pg_insert(Agent).values(
        vendor_id=vendor_id,
        vendor_agent_id=n.vendor_agent_id,
        name=n.name,
        language=n.language,
        voice_persona=n.voice_persona,
        result_schema=n.result_schema,
        raw_payload=n.raw_payload,
    ).on_conflict_do_update(
        index_elements=["vendor_id", "vendor_agent_id"],
        set_={
            "name": n.name,
            "language": n.language,
            "voice_persona": n.voice_persona,
            "result_schema": n.result_schema,
            "raw_payload": n.raw_payload,
        },
    ).returning(Agent.id)
    row = (await db.execute(stmt)).one()
    return row.id


# ---------------------------------------------------------------------------
# Campaigns — auto-created from request_id when we see a call we don't have
# a campaign row for yet.
# ---------------------------------------------------------------------------
async def ensure_campaign(
    db: AsyncSession,
    vendor_id: UUID,
    vendor_request_id: str,
    *,
    agent_id: UUID | None = None,
    started_at: datetime | None = None,
    name: str | None = None,
) -> UUID:
    res = await db.execute(
        select(Campaign.id).where(
            Campaign.vendor_id == vendor_id,
            Campaign.vendor_request_id == vendor_request_id,
        )
    )
    existing = res.scalar_one_or_none()
    if existing:
        return existing

    # Auto-name based on request_id if nothing else.
    auto_name = name or f"Campaign {vendor_request_id[:24]}"
    stmt = pg_insert(Campaign).values(
        vendor_id=vendor_id,
        vendor_request_id=vendor_request_id,
        name=auto_name,
        agent_id=agent_id,
        source="vendor_ui",
        started_at=started_at,
    ).on_conflict_do_nothing(index_elements=["vendor_id", "vendor_request_id"]).returning(Campaign.id)
    row = (await db.execute(stmt)).first()
    if row:
        return row.id

    res = await db.execute(
        select(Campaign.id).where(
            Campaign.vendor_id == vendor_id,
            Campaign.vendor_request_id == vendor_request_id,
        )
    )
    return res.scalar_one()


async def _agent_id_for(db: AsyncSession, vendor_id: UUID, vendor_agent_id: str | None) -> UUID | None:
    if not vendor_agent_id:
        return None
    res = await db.execute(
        select(Agent.id).where(
            Agent.vendor_id == vendor_id,
            Agent.vendor_agent_id == vendor_agent_id,
        )
    )
    return res.scalar_one_or_none()


# ---------------------------------------------------------------------------
# Calls
# ---------------------------------------------------------------------------
async def upsert_call(db: AsyncSession, vendor_id: UUID, n: NormalizedCall) -> UUID | None:
    if n.vendor_request_id and n.vendor_request_id in EXCLUDED_VENDOR_REQUEST_IDS:
        logger.debug("skipping excluded request_id=%s call_id=%s", n.vendor_request_id, n.vendor_call_id)
        return None

    agent_id = await _agent_id_for(db, vendor_id, n.vendor_agent_id)

    campaign_id: UUID | None = None
    if n.vendor_request_id:
        campaign_id = await ensure_campaign(
            db,
            vendor_id,
            n.vendor_request_id,
            agent_id=agent_id,
            started_at=n.vendor_created_at,
        )

    payload: dict[str, Any] = {
        "vendor_id": vendor_id,
        "vendor_call_id": n.vendor_call_id,
        "campaign_id": campaign_id,
        "agent_id": agent_id,
        "callee_name": n.callee_name,
        "mobile_number": n.mobile_number,
        "from_phone_number": n.from_phone_number,
        "language": n.language,
        "status": n.status,
        "lifecycle_status": n.lifecycle_status,
        "engagement_status": n.engagement_status,
        "answered_by": n.answered_by,
        "call_ended_by": n.call_ended_by,
        "duration_seconds": n.duration_seconds,
        "duration_minutes": n.duration_minutes,
        "user_speech_duration": n.user_speech_duration,
        "max_retries": n.max_retries,
        "retry_count": n.retry_count,
        "retries_left": n.retries_left,
        "recording_url": n.recording_url,
        "custom_data": n.custom_data,
        "result": n.result,
        "raw_payload": n.raw_payload,
        "started_at": n.started_at,
        "ended_at": n.ended_at,
        "vendor_created_at": n.vendor_created_at,
    }

    # Don't overwrite ingested_at — only set on insert.
    update_set = {k: v for k, v in payload.items() if k not in ("vendor_id", "vendor_call_id")}

    stmt = pg_insert(CallLog).values(**payload).on_conflict_do_update(
        index_elements=["vendor_id", "vendor_call_id"],
        set_=update_set,
    ).returning(CallLog.id)
    row = (await db.execute(stmt)).one()
    return row.id
