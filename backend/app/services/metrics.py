"""
Metrics computation.

All dashboard math lives here. Definitions are deliberate — when in doubt,
default to the most defensible (i.e. boring) interpretation.

DEFINITIONS:
  total_calls       = COUNT(*) of call_logs in the window
  connected_calls   = lifecycle_status='COMPLETED' AND answered_by='HUMAN'
                      Rationale: machine pickups are NOT a real connection.
  failed_calls      = status IN ('FAILED', 'NOT_CONNECTED', 'CANCELLED')
  connection_rate   = connected_calls / total_calls
  avg_call_duration = AVG(duration_seconds) WHERE connected
  engagement_rate   = COUNT engagement_status='ENGAGED' / connected_calls
  interest_rate     = COUNT result->>'interested' IN ('Yes','yes',...) / connected_calls
                      ('interested' is a Hunar convention; agents may use other keys)
  follow_up_rate    = COUNT result->>'follow_up_at' IS NOT NULL / connected_calls
  conversion_rate   = configurable per-deployment. v1 stub: same as interest_rate.
                      In production, you wire downstream lead status here.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any
from uuid import UUID

from sqlalchemy import and_, case, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import CallLog, Campaign, Vendor


@dataclass
class MetricFilters:
    start: datetime | None = None
    end: datetime | None = None
    vendor_ids: list[UUID] | None = None
    campaign_ids: list[UUID] | None = None
    agent_ids: list[UUID] | None = None

def apply(self, stmt):
        conds = []
        if self.start:
            conds.append(CallLog.vendor_created_at >= self.start)
        if self.end:
            conds.append(CallLog.vendor_created_at <= self.end)
        if self.vendor_ids:
            conds.append(CallLog.vendor_id.in_(self.vendor_ids))
        if self.campaign_ids:
            conds.append(CallLog.campaign_id.in_(self.campaign_ids))
        if self.agent_ids:
            conds.append(CallLog.agent_id.in_(self.agent_ids))
        if conds:
            stmt = stmt.where(and_(*conds))
        return stmt


# Reusable expressions
_is_connected = and_(CallLog.lifecycle_status == "COMPLETED", CallLog.answered_by == "HUMAN")
_is_engaged = CallLog.engagement_status == "ENGAGED"
# JSONB key check — `interested` is the Hunar convention. We accept truthy values.
_is_interested = func.lower(CallLog.result["interested"].astext).in_(["yes", "true", "interested"])
_has_follow_up = CallLog.result["follow_up_at"].astext.isnot(None)


def _safe_div(num: float | int | None, den: float | int | None) -> float:
    if not den:
        return 0.0
    return float(num or 0) / float(den)


# ---------------------------------------------------------------------------
# Top-level metrics block (the four big tiles on Overview page)
# ---------------------------------------------------------------------------
async def compute_overview_metrics(db: AsyncSession, filters: MetricFilters) -> dict[str, Any]:
    stmt = select(
        func.count(CallLog.id).label("total_calls"),
        func.sum(case((_is_connected, 1), else_=0)).label("connected_calls"),
        func.sum(case((CallLog.status.in_(("FAILED", "NOT_CONNECTED", "CANCELLED")), 1), else_=0)).label("failed_calls"),
        func.avg(case((_is_connected, CallLog.duration_seconds))).label("avg_duration_sec"),
        func.sum(case((and_(_is_connected, _is_engaged), 1), else_=0)).label("engaged_calls"),
        func.sum(case((and_(_is_connected, _is_interested), 1), else_=0)).label("interested_calls"),
        func.sum(case((and_(_is_connected, _has_follow_up), 1), else_=0)).label("follow_up_calls"),
    )
    stmt = filters.apply(stmt)
    row = (await db.execute(stmt)).one()

    total = int(row.total_calls or 0)
    connected = int(row.connected_calls or 0)
    failed = int(row.failed_calls or 0)
    engaged = int(row.engaged_calls or 0)
    interested = int(row.interested_calls or 0)
    follow_up = int(row.follow_up_calls or 0)

    return {
        "total_calls": total,
        "connected_calls": connected,
        "failed_calls": failed,
        "avg_duration_seconds": float(row.avg_duration_sec or 0),
        "engaged_calls": engaged,
        "interested_calls": interested,
        "follow_up_calls": follow_up,
        "connection_rate": _safe_div(connected, total),
        "engagement_rate": _safe_div(engaged, connected),
        "interest_rate": _safe_div(interested, connected),
        "follow_up_rate": _safe_div(follow_up, connected),
        "conversion_rate": _safe_div(interested, total),  # v1 proxy; wire real conversions in v2
    }


# ---------------------------------------------------------------------------
# Calls over time — bucketed by day for the line chart
# ---------------------------------------------------------------------------
async def calls_over_time(db: AsyncSession, filters: MetricFilters, bucket: str = "day") -> list[dict[str, Any]]:
    trunc = func.date_trunc(bucket, CallLog.vendor_created_at)
    stmt = (
        select(
            trunc.label("bucket"),
            func.count(CallLog.id).label("total"),
            func.sum(case((_is_connected, 1), else_=0)).label("connected"),
            func.sum(case((and_(_is_connected, _is_interested), 1), else_=0)).label("interested"),
        )
        .group_by(trunc)
        .order_by(trunc)
    )
    stmt = filters.apply(stmt)
    rows = (await db.execute(stmt)).all()
    return [
        {
            "bucket": r.bucket.isoformat() if r.bucket else None,
            "total": int(r.total or 0),
            "connected": int(r.connected or 0),
            "interested": int(r.interested or 0),
        }
        for r in rows
    ]


# ---------------------------------------------------------------------------
# Funnel: Total → Connected → Engaged → Interested → Follow-up
# ---------------------------------------------------------------------------
async def call_funnel(db: AsyncSession, filters: MetricFilters) -> list[dict[str, Any]]:
    m = await compute_overview_metrics(db, filters)
    return [
        {"stage": "Total dialed",    "count": m["total_calls"]},
        {"stage": "Connected",       "count": m["connected_calls"]},
        {"stage": "Engaged",         "count": m["engaged_calls"]},
        {"stage": "Interested",      "count": m["interested_calls"]},
        {"stage": "Follow-up booked","count": m["follow_up_calls"]},
    ]


# ---------------------------------------------------------------------------
# Vendor comparison — same metrics, broken down per vendor
# ---------------------------------------------------------------------------
async def vendor_comparison(db: AsyncSession, filters: MetricFilters) -> list[dict[str, Any]]:
    stmt = (
        select(
            Vendor.id.label("vendor_id"),
            Vendor.slug.label("vendor_slug"),
            Vendor.name.label("vendor_name"),
            func.count(CallLog.id).label("total"),
            func.sum(case((_is_connected, 1), else_=0)).label("connected"),
            func.avg(case((_is_connected, CallLog.duration_seconds))).label("avg_dur"),
            func.sum(case((and_(_is_connected, _is_engaged), 1), else_=0)).label("engaged"),
            func.sum(case((and_(_is_connected, _is_interested), 1), else_=0)).label("interested"),
            func.sum(case((and_(_is_connected, _has_follow_up), 1), else_=0)).label("follow_up"),
        )
        .join(CallLog, CallLog.vendor_id == Vendor.id)
        .group_by(Vendor.id, Vendor.slug, Vendor.name)
    )
    stmt = filters.apply(stmt)
    rows = (await db.execute(stmt)).all()
    out = []
    for r in rows:
        total = int(r.total or 0)
        connected = int(r.connected or 0)
        out.append({
            "vendor_id": str(r.vendor_id),
            "vendor_slug": r.vendor_slug,
            "vendor_name": r.vendor_name,
            "total_calls": total,
            "connected_calls": connected,
            "avg_duration_seconds": float(r.avg_dur or 0),
            "connection_rate": _safe_div(connected, total),
            "engagement_rate": _safe_div(int(r.engaged or 0), connected),
            "interest_rate": _safe_div(int(r.interested or 0), connected),
            "follow_up_rate": _safe_div(int(r.follow_up or 0), connected),
        })
    return out


# ---------------------------------------------------------------------------
# Campaign-level breakdown (for vendor analysis page)
# ---------------------------------------------------------------------------
async def campaign_breakdown(db: AsyncSession, filters: MetricFilters) -> list[dict[str, Any]]:
    stmt = (
        select(
            Campaign.id.label("campaign_id"),
            Campaign.name.label("campaign_name"),
            Campaign.vendor_id,
            Campaign.started_at,
            func.count(CallLog.id).label("total"),
            func.sum(case((_is_connected, 1), else_=0)).label("connected"),
            func.sum(case((and_(_is_connected, _is_interested), 1), else_=0)).label("interested"),
        )
        .join(CallLog, CallLog.campaign_id == Campaign.id)
        .group_by(Campaign.id, Campaign.name, Campaign.vendor_id, Campaign.started_at)
        .order_by(Campaign.started_at.desc())
    )
    stmt = filters.apply(stmt)
    rows = (await db.execute(stmt)).all()
    return [
        {
            "campaign_id": str(r.campaign_id),
            "campaign_name": r.campaign_name,
            "vendor_id": str(r.vendor_id),
            "started_at": r.started_at.isoformat() if r.started_at else None,
            "total_calls": int(r.total or 0),
            "connected_calls": int(r.connected or 0),
            "interested_calls": int(r.interested or 0),
            "connection_rate": _safe_div(int(r.connected or 0), int(r.total or 0)),
            "interest_rate": _safe_div(int(r.interested or 0), int(r.connected or 0)),
        }
        for r in rows
    ]


def default_window() -> tuple[datetime, datetime]:
    """Last 30 days, ending now."""
    end = datetime.utcnow()
    return end - timedelta(days=30), end


# ---------------------------------------------------------------------------
# Per-agent performance — answers "which AI script converts best?"
# ---------------------------------------------------------------------------
async def agent_breakdown(db: AsyncSession, filters: MetricFilters) -> list[dict[str, Any]]:
    from app.models import Agent  # local import to avoid circulars on module load

    stmt = (
        select(
            Agent.id.label("agent_id"),
            Agent.name.label("agent_name"),
            Agent.language.label("language"),
            Agent.voice_persona.label("voice_persona"),
            Vendor.name.label("vendor_name"),
            func.count(CallLog.id).label("total"),
            func.sum(case((_is_connected, 1), else_=0)).label("connected"),
            func.avg(case((_is_connected, CallLog.duration_seconds))).label("avg_dur"),
            func.sum(case((and_(_is_connected, _is_engaged), 1), else_=0)).label("engaged"),
            func.sum(case((and_(_is_connected, _is_interested), 1), else_=0)).label("interested"),
            func.sum(case((and_(_is_connected, _has_follow_up), 1), else_=0)).label("follow_up"),
        )
        .join(CallLog, CallLog.agent_id == Agent.id)
        .join(Vendor, Vendor.id == Agent.vendor_id)
        .group_by(Agent.id, Agent.name, Agent.language, Agent.voice_persona, Vendor.name)
        .order_by(func.count(CallLog.id).desc())
    )
    stmt = filters.apply(stmt)
    rows = (await db.execute(stmt)).all()
    out = []
    for r in rows:
        total = int(r.total or 0)
        connected = int(r.connected or 0)
        out.append({
            "agent_id": str(r.agent_id),
            "agent_name": r.agent_name,
            "vendor_name": r.vendor_name,
            "language": r.language,
            "voice_persona": r.voice_persona,
            "total_calls": total,
            "connected_calls": connected,
            "avg_duration_seconds": float(r.avg_dur or 0),
            "connection_rate": _safe_div(connected, total),
            "engagement_rate": _safe_div(int(r.engaged or 0), connected),
            "interest_rate": _safe_div(int(r.interested or 0), connected),
            "follow_up_rate": _safe_div(int(r.follow_up or 0), connected),
        })
    return out
