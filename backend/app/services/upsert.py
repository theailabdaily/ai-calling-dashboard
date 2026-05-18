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


# ---------------------------------------------------------------------------
# Allowlist (DB-driven)
# ---------------------------------------------------------------------------
# Agents are allowed to ingest IFF they have a product_line_id set on their row
# in the `agents` table. This means adding a new product line + agent is a pure
# SQL operation — no code deploys needed. Fail-closed by design: if an agent
# row doesn't exist or has NULL product_line_id, calls from it are silently
# dropped.
#
# Adding a new agent:
#   1. INSERT INTO product_lines (slug, name) VALUES ('banking', 'Banking');
#   2. INSERT INTO agents (vendor_id, vendor_agent_id, name, product_line_id) VALUES
#      (<hunar_vendor_id>, '<new_agent_uuid>', 'Banking - TOFU', <banking_id>);
#   3. Next cron run picks up calls from this agent automatically.
async def _is_allowed_agent(db: AsyncSession, vendor_id: UUID, vendor_agent_id: str) -> bool:
    """An agent is allowed iff a row exists in `agents` with a non-null product_line_id."""
    res = await db.execute(
        select(Agent.id).where(
            Agent.vendor_id == vendor_id,
            Agent.vendor_agent_id == vendor_agent_id,
            Agent.product_line_id.is_not(None),
        )
    )
    return res.first() is not None


async def _is_excluded_test_number(db: AsyncSession, mobile_number: str | None) -> bool:
    """Test calls (e.g. Hunar POC dialing their own number) get filtered here."""
    if not mobile_number:
        return False
    # excluded_test_numbers is a small ops table (~single-digit rows) managed via SQL.
    # No ORM model exists for it — use a parameterized text query.
    from sqlalchemy import text
    res = await db.execute(
        text("SELECT 1 FROM excluded_test_numbers WHERE mobile_number = :mn LIMIT 1"),
        {"mn": mobile_number},
    )
    return res.first() is not None


async def get_vendor_by_slug(db: AsyncSession, slug: str) -> Vendor | None:
    res = await db.execute(select(Vendor).where(Vendor.slug == slug))
    return res.scalar_one_or_none()


# ---------------------------------------------------------------------------
# Agents
# ---------------------------------------------------------------------------
async def upsert_agent(db: AsyncSession, vendor_id: UUID, n: NormalizedAgent) -> UUID | None:
    """
    Update existing agent rows with fresh data from vendor sync.
    Does NOT create new agents — they must be pre-seeded with a product_line_id
    via SQL before any of their calls can ingest. This is fail-closed.
    """
    if not await _is_allowed_agent(db, vendor_id, n.vendor_agent_id):
        logger.debug(
            "skipping agent (no product_line_id) vendor_agent_id=%s name=%s",
            n.vendor_agent_id, n.name,
        )
        return None
    # Agent row exists and is allowed — refresh its data fields.
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

    # Skip calls from agents not mapped to a product line (fail-closed).
    if n.vendor_agent_id and not await _is_allowed_agent(db, vendor_id, n.vendor_agent_id):
        logger.debug(
            "skipping call from non-allowed agent vendor_agent_id=%s call_id=%s",
            n.vendor_agent_id, n.vendor_call_id,
        )
        return None

    # Skip test calls (Hunar POC dialing their own number, etc).
    if await _is_excluded_test_number(db, n.mobile_number):
        logger.debug(
            "skipping test call to excluded number %s call_id=%s",
            n.mobile_number, n.vendor_call_id,
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
