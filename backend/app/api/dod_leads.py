"""DoD (Day-over-Day) Leads — campaigns grouped by their upload date with
sales-action bucket counts. Powers the DoD Leads sidebar page.

The grouping is by `vendor_created_at` (the time the lead was uploaded to
the vendor), bucketed to a calendar date in IST. Each row represents one
day's worth of leads, with an embedded per-campaign breakdown.

Counts are unique-phone counts within each grouping level:
- Day-level total = distinct phones uploaded that day
- Campaign-level total = distinct phones in that campaign
When a phone appears in multiple same-day campaigns, the sum of
campaign-level totals will exceed the day-level total — that's correct,
not a bug.
"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends
from sqlalchemy import and_, case, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models import CallLog, Campaign
from app.schemas import DodLeadCampaign, DodLeadDay, DodLeadsResponse

router = APIRouter(prefix="/api/dod-leads", tags=["dod-leads"])


# Predicates — kept identical to metrics.py / calls.py / exports.py so the
# tile counts here match the ones on overview and the call-logs filters.
_is_connected = and_(CallLog.lifecycle_status == "COMPLETED", CallLog.answered_by == "HUMAN")
_is_interested = func.upper(CallLog.result["interest_level"].astext).in_(["HIGH", "MEDIUM"])
_wants_callback = func.upper(CallLog.result["next_step_interest"].astext) == "CALLBACK"


def _phone_level_subquery(group_by_campaign: bool):
    """Build the per-phone aggregation that flattens multiple call_logs rows
    for the same phone into a single row of bool_or signals.

    When `group_by_campaign=True`, group by (mobile_number, campaign_id) so
    a phone in two campaigns becomes two rows — one per campaign. When
    `group_by_campaign=False`, group by (mobile_number, upload_day) so the
    same phone in two same-day campaigns becomes one row at the day level.
    """
    # IST calendar date of the upload time. Stored as timestamptz so the
    # AT TIME ZONE produces a `timestamp without time zone` in IST, which
    # we then DATE-truncate to a calendar day.
    day_ist = func.date(func.timezone("Asia/Kolkata", CallLog.vendor_created_at)).label("day_ist")

    cols = [
        CallLog.mobile_number.label("phone"),
        day_ist,
        func.bool_or(_is_connected).label("connected"),
        func.bool_or(and_(_is_connected, _is_interested)).label("interested"),
        func.bool_or(and_(_is_connected, _wants_callback)).label("callback"),
    ]
    if group_by_campaign:
        cols.append(CallLog.campaign_id.label("campaign_id"))

    stmt = (
        select(*cols)
        .where(and_(CallLog.mobile_number.isnot(None), CallLog.mobile_number != ""))
        .group_by(
            CallLog.mobile_number,
            day_ist,
            *([CallLog.campaign_id] if group_by_campaign else []),
        )
    )
    return stmt.subquery()


@router.get("", response_model=DodLeadsResponse)
async def get_dod_leads(db: AsyncSession = Depends(get_db)):
    """Return all upload-days with campaign breakdown, newest first.

    No filters in v1 — the table is small (one row per upload day, typically
    < 100 rows even after a year of operation). If we later need date-window
    or vendor scoping, plug it in via Depends(parse_filters) at the router.
    """
    # ---- Day-level aggregation ----
    pl_day = _phone_level_subquery(group_by_campaign=False)

    # Counters: for each phone-day row, classify into exactly one bucket.
    # The buckets are mutually exclusive among connected leads. Unreached
    # leads (NOT connected) get their own bucket so the row math reconciles.
    day_stmt = (
        select(
            pl_day.c.day_ist,
            func.count().label("total_leads"),
            func.count().filter(and_(pl_day.c.connected, pl_day.c.interested, pl_day.c.callback))
                .label("top_priority"),
            func.count().filter(and_(pl_day.c.connected, pl_day.c.interested, ~pl_day.c.callback))
                .label("interested_only"),
            func.count().filter(and_(pl_day.c.connected, ~pl_day.c.interested, pl_day.c.callback))
                .label("callback_only"),
            func.count().filter(and_(pl_day.c.connected, ~pl_day.c.interested, ~pl_day.c.callback))
                .label("no_intent"),
            func.count().filter(~pl_day.c.connected).label("unreached"),
        )
        .group_by(pl_day.c.day_ist)
        .order_by(pl_day.c.day_ist.desc())
    )
    day_rows = (await db.execute(day_stmt)).all()

    # ---- Campaign-level aggregation ----
    # Same shape but grouped also by campaign_id, then joined to campaigns
    # for the human-readable name. We build the per-campaign aggregation
    # first as a subquery, then join campaigns on top.
    pl_camp = _phone_level_subquery(group_by_campaign=True)

    camp_agg = (
        select(
            pl_camp.c.day_ist,
            pl_camp.c.campaign_id,
            func.count().label("total_leads"),
            func.count().filter(and_(pl_camp.c.connected, pl_camp.c.interested, pl_camp.c.callback))
                .label("top_priority"),
            func.count().filter(and_(pl_camp.c.connected, pl_camp.c.interested, ~pl_camp.c.callback))
                .label("interested_only"),
            func.count().filter(and_(pl_camp.c.connected, ~pl_camp.c.interested, pl_camp.c.callback))
                .label("callback_only"),
            func.count().filter(and_(pl_camp.c.connected, ~pl_camp.c.interested, ~pl_camp.c.callback))
                .label("no_intent"),
            func.count().filter(~pl_camp.c.connected).label("unreached"),
        )
        .group_by(pl_camp.c.day_ist, pl_camp.c.campaign_id)
    ).subquery()

    camp_stmt = (
        select(
            camp_agg.c.day_ist,
            camp_agg.c.campaign_id,
            Campaign.name.label("campaign_name"),
            camp_agg.c.total_leads,
            camp_agg.c.top_priority,
            camp_agg.c.interested_only,
            camp_agg.c.callback_only,
            camp_agg.c.no_intent,
            camp_agg.c.unreached,
        )
        .join(Campaign, Campaign.id == camp_agg.c.campaign_id, isouter=True)
        .order_by(camp_agg.c.day_ist.desc(), Campaign.name)
    )
    camp_rows = (await db.execute(camp_stmt)).all()

    # ---- Stitch: group campaigns under their date ----
    by_day: dict[Any, list[DodLeadCampaign]] = {}
    for r in camp_rows:
        by_day.setdefault(r.day_ist, []).append(
            DodLeadCampaign(
                campaign_id=str(r.campaign_id) if r.campaign_id else "",
                campaign_name=r.campaign_name or "(unknown campaign)",
                total_leads=int(r.total_leads or 0),
                top_priority=int(r.top_priority or 0),
                interested_only=int(r.interested_only or 0),
                callback_only=int(r.callback_only or 0),
                no_intent=int(r.no_intent or 0),
                unreached=int(r.unreached or 0),
            )
        )

    days = [
        DodLeadDay(
            date=r.day_ist.isoformat(),
            total_leads=int(r.total_leads or 0),
            top_priority=int(r.top_priority or 0),
            interested_only=int(r.interested_only or 0),
            callback_only=int(r.callback_only or 0),
            no_intent=int(r.no_intent or 0),
            unreached=int(r.unreached or 0),
            campaigns=by_day.get(r.day_ist, []),
        )
        for r in day_rows
    ]

    return DodLeadsResponse(days=days, total_days=len(days))
