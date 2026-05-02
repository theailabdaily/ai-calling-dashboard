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

from sqlalchemy import and_, case, desc, distinct, func, literal, or_, select
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
# JSONB key check — Hunar uses qualitative levels.
# interest_level: HIGH | MEDIUM | LOW | "Not Covered" | "NOT AVAILABLE"
# next_step_interest: CALLBACK | NONE | UNSURE | "Not Covered" | "NOT AVAILABLE"
_is_interested = func.upper(CallLog.result["interest_level"].astext).in_(["HIGH", "MEDIUM"])
_has_follow_up = func.upper(CallLog.result["next_step_interest"].astext) == "CALLBACK"


def _safe_div(num: float | int | None, den: float | int | None) -> float:
    if not den:
        return 0.0
    return float(num or 0) / float(den)


# ---------------------------------------------------------------------------
# Top-level metrics block (the four big tiles on Overview page)
# ---------------------------------------------------------------------------
async def compute_overview_metrics(db: AsyncSession, filters: MetricFilters) -> dict[str, Any]:
    # unique_leads = count of distinct mobile numbers — one person dialed N times = 1 lead.
    # Empty/NULL numbers excluded so we don't undercount silently.
    _valid_phone = case(
        (and_(CallLog.mobile_number.isnot(None), CallLog.mobile_number != ""), CallLog.mobile_number)
    )
    stmt = select(
        func.count(CallLog.id).label("total_calls"),
        func.count(distinct(_valid_phone)).label("unique_leads"),
        func.sum(case((_is_connected, 1), else_=0)).label("connected_calls"),
        func.count(distinct(case((_is_connected, CallLog.mobile_number)))).label("unique_connected_leads"),
        func.count(distinct(case((and_(_is_connected, _is_interested), CallLog.mobile_number)))).label("unique_interested_leads"),
        func.sum(case((CallLog.status.in_(("FAILED", "NOT_CONNECTED", "CANCELLED")), 1), else_=0)).label("failed_calls"),
        func.avg(case((_is_connected, CallLog.duration_seconds))).label("avg_duration_sec"),
        func.sum(case((and_(_is_connected, _is_engaged), 1), else_=0)).label("engaged_calls"),
        func.sum(case((and_(_is_connected, _is_interested), 1), else_=0)).label("interested_calls"),
        func.sum(case((and_(_is_connected, _has_follow_up), 1), else_=0)).label("follow_up_calls"),
    )
    stmt = filters.apply(stmt)
    row = (await db.execute(stmt)).one()

    total = int(row.total_calls or 0)
    unique_leads = int(row.unique_leads or 0)
    unique_connected = int(row.unique_connected_leads or 0)
    unique_interested = int(row.unique_interested_leads or 0)
    connected = int(row.connected_calls or 0)
    failed = int(row.failed_calls or 0)
    engaged = int(row.engaged_calls or 0)
    interested = int(row.interested_calls or 0)
    follow_up = int(row.follow_up_calls or 0)

    return {
        "total_calls": total,
        "unique_leads": unique_leads,
        "unique_connected_leads": unique_connected,
        "unique_interested_leads": unique_interested,
        "connected_calls": connected,
        "failed_calls": failed,
        "avg_duration_seconds": float(row.avg_duration_sec or 0),
        "engaged_calls": engaged,
        "interested_calls": interested,
        "follow_up_calls": follow_up,
        # NOTE on rates — kept call-based to preserve historical comparisons.
        # Lead-based variants below are additive; consumers can pick either.
        "connection_rate": _safe_div(connected, total),
        "engagement_rate": _safe_div(engaged, connected),
        "interest_rate": _safe_div(interested, connected),
        "follow_up_rate": _safe_div(follow_up, connected),
        "conversion_rate": _safe_div(interested, total),  # v1 proxy; wire real conversions in v2
        "lead_conversion_rate": _safe_div(unique_interested, unique_leads),
        "attempts_per_lead": (total / unique_leads) if unique_leads else 0.0,
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
    _valid_phone_vc = case(
        (and_(CallLog.mobile_number.isnot(None), CallLog.mobile_number != ""), CallLog.mobile_number)
    )
    stmt = (
        select(
            Vendor.id.label("vendor_id"),
            Vendor.slug.label("vendor_slug"),
            Vendor.name.label("vendor_name"),
            func.count(CallLog.id).label("total"),
            func.count(distinct(_valid_phone_vc)).label("unique_leads"),
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
        unique_leads = int(r.unique_leads or 0)
        out.append({
            "vendor_id": str(r.vendor_id),
            "vendor_slug": r.vendor_slug,
            "vendor_name": r.vendor_name,
            "total_calls": total,
            "unique_leads": unique_leads,
            "connected_calls": connected,
            "avg_duration_seconds": float(r.avg_dur or 0),
            "connection_rate": _safe_div(connected, total),
            "engagement_rate": _safe_div(int(r.engaged or 0), connected),
            "interest_rate": _safe_div(int(r.interested or 0), connected),
            "follow_up_rate": _safe_div(int(r.follow_up or 0), connected),
            "attempts_per_lead": (total / unique_leads) if unique_leads else 0.0,
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
            Vendor.name.label("vendor_name"),
            Campaign.started_at,
            func.count(CallLog.id).label("total"),
            func.sum(case((_is_connected, 1), else_=0)).label("connected"),
            func.sum(case((and_(_is_connected, _is_interested), 1), else_=0)).label("interested"),
        )
        .join(CallLog, CallLog.campaign_id == Campaign.id)
        .join(Vendor, Vendor.id == Campaign.vendor_id)
        .group_by(Campaign.id, Campaign.name, Campaign.vendor_id, Vendor.name, Campaign.started_at)
        .order_by(Campaign.started_at.desc())
    )
    stmt = filters.apply(stmt)
    rows = (await db.execute(stmt)).all()
    out = []
    for r in rows:
        date_str = r.started_at.strftime("%Y-%m-%d") if r.started_at else None
        parts = [p for p in (date_str, r.vendor_name, r.campaign_name) if p]
        display = " — ".join(parts)
        out.append({
            "campaign_id": str(r.campaign_id),
            "campaign_name": r.campaign_name,
            "display_name": display,
            "vendor_id": str(r.vendor_id),
            "vendor_name": r.vendor_name,
            "started_at": r.started_at.isoformat() if r.started_at else None,
            "total_calls": int(r.total or 0),
            "connected_calls": int(r.connected or 0),
            "interested_calls": int(r.interested or 0),
            "connection_rate": _safe_div(int(r.connected or 0), int(r.total or 0)),
            "interest_rate": _safe_div(int(r.interested or 0), int(r.connected or 0)),
        })
    return out



# ---------------------------------------------------------------------------
# Hourly breakdown — what hour of day are we calling, and does it work?
# Bucketed in IST (Asia/Kolkata) since the calling operation is India-based.
# ---------------------------------------------------------------------------
async def hourly_breakdown(db: AsyncSession, filters: MetricFilters) -> list[dict[str, Any]]:
    # date_part('hour', ts AT TIME ZONE 'Asia/Kolkata') gives 0..23
    hour_expr = func.date_part(
        "hour",
        func.timezone("Asia/Kolkata", CallLog.vendor_created_at),
    )
    stmt = (
        select(
            hour_expr.label("hour"),
            func.count(CallLog.id).label("total"),
            func.sum(case((_is_connected, 1), else_=0)).label("connected"),
            func.avg(case((_is_connected, CallLog.duration_seconds))).label("avg_dur"),
            func.sum(case((and_(_is_connected, _is_engaged), 1), else_=0)).label("engaged"),
            func.sum(case((and_(_is_connected, _is_interested), 1), else_=0)).label("interested"),
        )
        .group_by(hour_expr)
        .order_by(hour_expr)
    )
    stmt = filters.apply(stmt)
    rows = (await db.execute(stmt)).all()
    out = []
    for r in rows:
        total = int(r.total or 0)
        connected = int(r.connected or 0)
        engaged = int(r.engaged or 0)
        interested = int(r.interested or 0)
        out.append({
            "hour": int(r.hour),
            "total_calls": total,
            "connected_calls": connected,
            "engaged_calls": engaged,
            "interested_calls": interested,
            "avg_duration_seconds": float(r.avg_dur or 0),
            "connection_rate": _safe_div(connected, total),
            "engagement_rate": _safe_div(engaged, connected),
            "interest_rate": _safe_div(interested, connected),
        })
    return out

def default_window() -> tuple[datetime, datetime]:
    """Last 30 days, ending now."""
    end = datetime.utcnow()
    return end - timedelta(days=30), end


# ---------------------------------------------------------------------------
# Hourly Insights — full payload for the /hourly-insights page
# Returns: hour rollup, dow rollup, dow×hour heatmap matrix,
#          per-vendor hour split, per-campaign hour split
# Single endpoint, single fetch — frontend slices it.
# ---------------------------------------------------------------------------
_DOW_NAMES = {1: "Mon", 2: "Tue", 3: "Wed", 4: "Thu", 5: "Fri", 6: "Sat", 7: "Sun"}


def _hour_expr_ist():
    return func.date_part("hour", func.timezone("Asia/Kolkata", CallLog.vendor_created_at))


def _dow_expr_ist():
    # ISODOW: 1=Mon ... 7=Sun -- intuitive sort order
    return func.extract("isodow", func.timezone("Asia/Kolkata", CallLog.vendor_created_at))


def _bucket_row_to_dict(r, key: str) -> dict[str, Any]:
    """Shared shape: hour OR dow bucket → metric dict."""
    total = int(r.total or 0)
    connected = int(r.connected or 0)
    engaged = int(r.engaged or 0)
    interested = int(r.interested or 0)
    out = {
        "total_calls": total,
        "connected_calls": connected,
        "engaged_calls": engaged,
        "interested_calls": interested,
        "avg_duration_seconds": float(r.avg_dur or 0),
        "connection_rate": _safe_div(connected, total),
        "engagement_rate": _safe_div(engaged, connected),
        "interest_rate": _safe_div(interested, connected),
    }
    if key == "hour":
        out["hour"] = int(r.hour)
    else:
        dow = int(r.dow)
        out["dow"] = dow
        out["dow_name"] = _DOW_NAMES.get(dow, str(dow))
    return out


async def _hour_breakdown(db: AsyncSession, filters: MetricFilters) -> list[dict[str, Any]]:
    h = _hour_expr_ist()
    stmt = (
        select(
            h.label("hour"),
            func.count(CallLog.id).label("total"),
            func.sum(case((_is_connected, 1), else_=0)).label("connected"),
            func.avg(case((_is_connected, CallLog.duration_seconds))).label("avg_dur"),
            func.sum(case((and_(_is_connected, _is_engaged), 1), else_=0)).label("engaged"),
            func.sum(case((and_(_is_connected, _is_interested), 1), else_=0)).label("interested"),
        )
        .group_by(h)
        .order_by(h)
    )
    stmt = filters.apply(stmt)
    rows = (await db.execute(stmt)).all()
    return [_bucket_row_to_dict(r, "hour") for r in rows]


async def _dow_breakdown(db: AsyncSession, filters: MetricFilters) -> list[dict[str, Any]]:
    d = _dow_expr_ist()
    stmt = (
        select(
            d.label("dow"),
            func.count(CallLog.id).label("total"),
            func.sum(case((_is_connected, 1), else_=0)).label("connected"),
            func.avg(case((_is_connected, CallLog.duration_seconds))).label("avg_dur"),
            func.sum(case((and_(_is_connected, _is_engaged), 1), else_=0)).label("engaged"),
            func.sum(case((and_(_is_connected, _is_interested), 1), else_=0)).label("interested"),
        )
        .group_by(d)
        .order_by(d)
    )
    stmt = filters.apply(stmt)
    rows = (await db.execute(stmt)).all()
    return [_bucket_row_to_dict(r, "dow") for r in rows]


async def _dow_hour_heatmap(db: AsyncSession, filters: MetricFilters) -> list[dict[str, Any]]:
    h = _hour_expr_ist()
    d = _dow_expr_ist()
    stmt = (
        select(
            d.label("dow"),
            h.label("hour"),
            func.count(CallLog.id).label("total"),
            func.sum(case((_is_connected, 1), else_=0)).label("connected"),
            func.avg(case((_is_connected, CallLog.duration_seconds))).label("avg_dur"),
            func.sum(case((and_(_is_connected, _is_engaged), 1), else_=0)).label("engaged"),
            func.sum(case((and_(_is_connected, _is_interested), 1), else_=0)).label("interested"),
        )
        .group_by(d, h)
        .order_by(d, h)
    )
    stmt = filters.apply(stmt)
    rows = (await db.execute(stmt)).all()
    out = []
    for r in rows:
        total = int(r.total or 0)
        connected = int(r.connected or 0)
        engaged = int(r.engaged or 0)
        interested = int(r.interested or 0)
        dow = int(r.dow)
        out.append({
            "dow": dow,
            "dow_name": _DOW_NAMES.get(dow, str(dow)),
            "hour": int(r.hour),
            "total_calls": total,
            "connected_calls": connected,
            "engaged_calls": engaged,
            "interested_calls": interested,
            "avg_duration_seconds": float(r.avg_dur or 0),
            "connection_rate": _safe_div(connected, total),
            "engagement_rate": _safe_div(engaged, connected),
            "interest_rate": _safe_div(interested, connected),
        })
    return out


async def _hour_by_vendor(db: AsyncSession, filters: MetricFilters) -> list[dict[str, Any]]:
    h = _hour_expr_ist()
    stmt = (
        select(
            Vendor.id.label("vendor_id"),
            Vendor.name.label("vendor_name"),
            h.label("hour"),
            func.count(CallLog.id).label("total"),
            func.sum(case((_is_connected, 1), else_=0)).label("connected"),
            func.avg(case((_is_connected, CallLog.duration_seconds))).label("avg_dur"),
            func.sum(case((and_(_is_connected, _is_engaged), 1), else_=0)).label("engaged"),
            func.sum(case((and_(_is_connected, _is_interested), 1), else_=0)).label("interested"),
        )
        .join(CallLog, CallLog.vendor_id == Vendor.id)
        .group_by(Vendor.id, Vendor.name, h)
        .order_by(Vendor.name, h)
    )
    stmt = filters.apply(stmt)
    rows = (await db.execute(stmt)).all()

    # Group rows by vendor
    by_v: dict[str, dict[str, Any]] = {}
    for r in rows:
        vid = str(r.vendor_id)
        if vid not in by_v:
            by_v[vid] = {"vendor_id": vid, "vendor_name": r.vendor_name, "hours": []}
        total = int(r.total or 0)
        connected = int(r.connected or 0)
        engaged = int(r.engaged or 0)
        interested = int(r.interested or 0)
        by_v[vid]["hours"].append({
            "hour": int(r.hour),
            "total_calls": total,
            "connected_calls": connected,
            "engaged_calls": engaged,
            "interested_calls": interested,
            "avg_duration_seconds": float(r.avg_dur or 0),
            "connection_rate": _safe_div(connected, total),
            "engagement_rate": _safe_div(engaged, connected),
            "interest_rate": _safe_div(interested, connected),
        })
    return list(by_v.values())


async def _hour_by_campaign(db: AsyncSession, filters: MetricFilters, top_n: int = 6) -> list[dict[str, Any]]:
    """Top N campaigns by volume in window, each with hourly breakdown."""
    # Identify top campaigns first
    top_stmt = (
        select(Campaign.id, func.count(CallLog.id).label("n"))
        .join(CallLog, CallLog.campaign_id == Campaign.id)
        .group_by(Campaign.id)
        .order_by(func.count(CallLog.id).desc())
        .limit(top_n)
    )
    top_stmt = filters.apply(top_stmt)
    top_ids = [r.id for r in (await db.execute(top_stmt)).all()]
    if not top_ids:
        return []

    h = _hour_expr_ist()
    stmt = (
        select(
            Campaign.id.label("campaign_id"),
            Campaign.name.label("campaign_name"),
            Vendor.name.label("vendor_name"),
            Campaign.started_at,
            h.label("hour"),
            func.count(CallLog.id).label("total"),
            func.sum(case((_is_connected, 1), else_=0)).label("connected"),
            func.avg(case((_is_connected, CallLog.duration_seconds))).label("avg_dur"),
            func.sum(case((and_(_is_connected, _is_engaged), 1), else_=0)).label("engaged"),
            func.sum(case((and_(_is_connected, _is_interested), 1), else_=0)).label("interested"),
        )
        .join(CallLog, CallLog.campaign_id == Campaign.id)
        .join(Vendor, Vendor.id == Campaign.vendor_id)
        .where(Campaign.id.in_(top_ids))
        .group_by(Campaign.id, Campaign.name, Vendor.name, Campaign.started_at, h)
        .order_by(Campaign.started_at.desc().nulls_last(), h)
    )
    stmt = filters.apply(stmt)
    rows = (await db.execute(stmt)).all()

    by_c: dict[str, dict[str, Any]] = {}
    for r in rows:
        cid = str(r.campaign_id)
        if cid not in by_c:
            date_str = r.started_at.strftime("%Y-%m-%d") if r.started_at else None
            parts = [p for p in (date_str, r.vendor_name, r.campaign_name) if p]
            display = " — ".join(parts)
            by_c[cid] = {
                "campaign_id": cid,
                "campaign_name": r.campaign_name,
                "display_name": display,
                "hours": [],
            }
        total = int(r.total or 0)
        connected = int(r.connected or 0)
        engaged = int(r.engaged or 0)
        interested = int(r.interested or 0)
        by_c[cid]["hours"].append({
            "hour": int(r.hour),
            "total_calls": total,
            "connected_calls": connected,
            "engaged_calls": engaged,
            "interested_calls": interested,
            "avg_duration_seconds": float(r.avg_dur or 0),
            "connection_rate": _safe_div(connected, total),
            "engagement_rate": _safe_div(engaged, connected),
            "interest_rate": _safe_div(interested, connected),
        })
    return list(by_c.values())


async def hourly_insights(db: AsyncSession, filters: MetricFilters) -> dict[str, Any]:
    """Single payload for the /hourly-insights page.

    All sub-queries share the same filter window so cross-cutting comparisons
    are consistent. Five sections:
      - hour_breakdown:   one row per hour 0..23 (only hours with data)
      - dow_breakdown:    one row per weekday 1..7 (only days with data)
      - heatmap:          dow × hour cells (only cells with data)
      - by_vendor:        per-vendor hour split
      - by_campaign:      top-6 campaigns by volume, each with hour split
    """
    return {
        "hour_breakdown":  await _hour_breakdown(db, filters),
        "dow_breakdown":   await _dow_breakdown(db, filters),
        "heatmap":         await _dow_hour_heatmap(db, filters),
        "by_vendor":       await _hour_by_vendor(db, filters),
        "by_campaign":     await _hour_by_campaign(db, filters),
    }


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



# ---------------------------------------------------------------------------
# Outcome distribution — Hunar-style taxonomy built from our raw fields.
# Two views:
#   by_call: every call counted, grouped by outcome
#   by_lead: deduped to last call per lead (mobile_number), then grouped
# ---------------------------------------------------------------------------
def _outcome_case():
    """SQL CASE expression mapping (status, answered_by, result fields, duration)
    onto a clean outcome label. Order matters — first match wins."""
    return case(
        # Pre-call states
        (CallLog.status == "SCHEDULED", literal("Scheduled (not yet dialed)")),
        (CallLog.status == "FAILED", literal("Failed (vendor)")),
        (CallLog.status == "CANCELLED", literal("Cancelled")),
        # Connection failures
        (and_(CallLog.status == "NOT_CONNECTED", CallLog.answered_by == "MACHINE"), literal("Voicemail")),
        (CallLog.status == "NOT_CONNECTED", literal("Phone Not Answered")),
        # Connected — but answered_by is MACHINE means a voicemail picked up
        (CallLog.answered_by == "MACHINE", literal("Voicemail")),
        # Connected — outcomes from result JSONB
        (CallLog.result["next_step_interest"].astext == "CALLBACK", literal("Callback Booked")),
        (CallLog.result["objection_type"].astext == "NOT_INTERESTED", literal("Not Interested")),
        (CallLog.result["objection_type"].astext == "TIME", literal("Objection: Time")),
        (CallLog.result["objection_type"].astext == "FEES", literal("Objection: Fees")),
        (CallLog.result["objection_type"].astext == "CAREER_CONFUSION", literal("Objection: Career")),
        (and_(CallLog.duration_seconds.isnot(None), CallLog.duration_seconds < 15), literal("Short Hangup")),
        (CallLog.result["interest_level"].astext == "HIGH", literal("High Interest")),
        (CallLog.result["interest_level"].astext == "MEDIUM", literal("Medium Interest")),
        (CallLog.result["interest_level"].astext == "LOW", literal("Low Interest")),
        (CallLog.result["interest_level"].astext.in_(["Not Covered", "NOT AVAILABLE"]), literal("Connected — Outcome Unclear")),
        else_=literal("Other"),
    )


async def outcome_distribution(db: AsyncSession, filters: MetricFilters) -> dict[str, list[dict[str, Any]]]:
    """Return {by_call: [...], by_lead: [...]} with outcome counts + percentages.
    by_lead deduplicates to the most recent call per mobile_number.
    """
    # ---------- by_call ----------
    outcome = _outcome_case().label("outcome")
    call_stmt = select(outcome, func.count().label("n"))
    call_stmt = filters.apply(call_stmt).group_by("outcome").order_by(desc("n"))
    call_rows = (await db.execute(call_stmt)).all()
    total_calls = sum(int(r.n) for r in call_rows) or 1

    by_call = [
        {"outcome": r.outcome or "Other", "count": int(r.n), "pct": int(r.n) / total_calls}
        for r in call_rows
    ]

    # ---------- by_lead ----------
    # Inner query: rank calls per mobile_number (latest first); take rn=1.
    # We do this in two SELECTs because window functions can't combine with GROUP BY easily.
    valid_phone = and_(CallLog.mobile_number.isnot(None), CallLog.mobile_number != "")
    rn = func.row_number().over(
        partition_by=CallLog.mobile_number,
        order_by=[CallLog.started_at.desc().nullslast(), CallLog.vendor_created_at.desc()],
    ).label("rn")

    inner = select(
        outcome,
        rn,
    ).where(valid_phone)
    inner = filters.apply(inner).subquery()

    lead_stmt = select(inner.c.outcome, func.count().label("n")).where(inner.c.rn == 1).group_by(inner.c.outcome).order_by(desc("n"))
    lead_rows = (await db.execute(lead_stmt)).all()
    total_leads = sum(int(r.n) for r in lead_rows) or 1

    by_lead = [
        {"outcome": r.outcome or "Other", "count": int(r.n), "pct": int(r.n) / total_leads}
        for r in lead_rows
    ]

    return {"by_call": by_call, "by_lead": by_lead}
