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


# Hard inclusion list of vendor_agent_ids we actually care about. Anything from
# an agent NOT in this set is silently dropped at ingest time — both at the
# agent sync (upsert_agent) and at the call sync (upsert_call). This prevents
# Hunar's POC test calls (using their own test agents like UPSC-TOFU, UPS-DNP)
# from polluting our dashboard with phantom 1-lead "campaigns".
#
# Fail-closed by design: a new agent created on Hunar's side will NOT auto-
# appear here. When we add a real second agent for our team (e.g. Banking,
# CTET), we extend this set explicitly.
ALLOWED_VENDOR_AGENT_IDS: set[str] = {
    "7448ffa2-0073-47b0-8c63-8073939b2bda",  # UGC NET Agent (Hindi) — the only one we run
}


async def get_vendor_by_slug(db: AsyncSession, slug: str) -> Vendor | None:
    res = await db.execute(select(Vendor).where(Vendor.slug == slug))
    return res.scalar_one_or_none()


# ---------------------------------------------------------------------------
# Agents
# ---------------------------------------------------------------------------
async def upsert_agent(db: AsyncSession, vendor_id: UUID, n: NormalizedAgent) -> UUID | None:
    if n.vendor_agent_id not in ALLOWED_VENDOR_AGENT_IDS:
        logger.debug(
            "skipping non-allowed agent vendor_agent_id=%s name=%s",
            n.vendor_agent_id, n.name,
        )
        return None
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
    vendor_campaign_id: str | None = None,
) -> UUID:
    # Defense in depth: even if some other code path reaches this fn directly
    # (e.g. a future campaign-list sync), refuse to create excluded campaigns.
    # Returns None semantically — but the type is UUID, so we raise instead so
    # callers don't silently store None as a campaign_id.
    if vendor_request_id in EXCLUDED_VENDOR_REQUEST_IDS:
        logger.debug("ensure_campaign refused excluded request_id=%s", vendor_request_id)
        raise ValueError(f"campaign vendor_request_id={vendor_request_id} is excluded")

    res = await db.execute(
        select(Campaign.id, Campaign.vendor_campaign_id).where(
            Campaign.vendor_id == vendor_id,
            Campaign.vendor_request_id == vendor_request_id,
        )
    )
    existing = res.first()
    if existing:
        # Back-fill vendor_campaign_id if we now have it and the row is missing it.
        # Cheap, idempotent — only updates when we have new info.
        if vendor_campaign_id and not existing.vendor_campaign_id:
            await db.execute(
                Campaign.__table__.update()
                .where(Campaign.id == existing.id)
                .values(vendor_campaign_id=vendor_campaign_id)
            )
        return existing.id

    # Auto-name based on request_id if nothing else.
    auto_name = name or f"Campaign {vendor_request_id[:24]}"
    stmt = pg_insert(Campaign).values(
        vendor_id=vendor_id,
        vendor_request_id=vendor_request_id,
        vendor_campaign_id=vendor_campaign_id,
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

    if n.vendor_agent_id and n.vendor_agent_id not in ALLOWED_VENDOR_AGENT_IDS:
        logger.debug(
            "skipping call from non-allowed agent vendor_agent_id=%s call_id=%s",
            n.vendor_agent_id, n.vendor_call_id,
        )
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
            vendor_campaign_id=n.vendor_campaign_id,
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
