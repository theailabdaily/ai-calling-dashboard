"""DoD Leads — leads grouped by FINAL LEAD STATUS DATE.

Each phone is collapsed to a single row whose date is the calendar day of
its most recent call activity in IST:

    final_at = MAX(COALESCE(ended_at, vendor_created_at)) over all the
               phone's call_logs rows

For a connected call this is the moment the call ended; for a still-
pending lead it falls back to vendor_created_at (the upload time) so
unreached leads still surface on a date.

This replaces the v1 grouping by `vendor_created_at` (upload date). The
new semantics answer the BD-relevant question — "which leads reached
their final status today" — rather than the operational question "which
leads were uploaded today".

Counts are unique-phone counts within each grouping level:
- Day-level total = distinct phones whose final status fell on that day
- Campaign-level total = distinct phones in that campaign whose final
  status within that campaign fell on that day

A phone in two campaigns can appear on different days at the campaign
level (each campaign computes its own final_at). Day-level total may not
equal the sum of campaign-level totals on the same day — that's
correct, not a bug.
"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends
from sqlalchemy import and_, func, select
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
    """Per-phone aggregation that flattens multiple call_logs rows for the
    same phone into a single row with bool_or signals + final timestamp.

    `final_at` is MAX(COALESCE(ended_at, vendor_created_at)) — the latest
    moment in the phone's lifecycle. ended_at is preferred because it
    represents call completion; vendor_created_at is the fallback for
    rows that never reached an end (still ringing, scheduled, etc.).

    When `group_by_campaign=True`, group by (mobile_number, campaign_id)
    so a phone in two campaigns becomes two rows — one per campaign,
    each with its own final_at within that campaign. When False, group
    by mobile_number only — one row per phone with the globally latest
    timestamp.
    """
    final_at = func.coalesce(CallLog.ended_at, CallLog.vendor_created_at)

    cols = [
        CallLog.mobile_number.label("phone"),
        func.max(final_at).label("final_at"),
        func.bool_or(_is_connected).label("connected"),
        func.bool_or(and_(_is_connected, _is_interested)).label("interested"),
        func.bool_or(and_(_is_connected, _wants_callback)).label("callback"),
    ]
    group_cols = [CallLog.mobile_number]
    if group_by_campaign:
        cols.append(CallLog.campaign_id.label("campaign_id"))
        group_cols.append(CallLog.campaign_id)

    stmt = (
        select(*cols)
        .where(and_(CallLog.mobile_number.isnot(None), CallLog.mobile_number != ""))
        .group_by(*group_cols)
    )
    return stmt.subquery()


@router.get("", response_model=DodLeadsResponse)
async def get_dod_leads(db: AsyncSession = Depends(get_db)):
    """Return all final-status-days with campaign breakdown, newest first.

    No query params in v1 — the table is small (one row per status day,
    typically < 100 rows even after a year of operation). The frontend
    applies date-range filtering client-side. If we later need backend
    date scoping, plug it in via Depends(parse_filters) at the router.
    """
    # ---- Day-level aggregation ----
    pl_day = _phone_level_subquery(group_by_campaign=False)
    day_ist = func.date(func.timezone("Asia/Kolkata", pl_day.c.final_at)).label("day_ist")

    # For each phone, classify into exactly one bucket. The buckets are
    # mutually exclusive among connected leads. Unreached leads (NOT
    # connected) get their own bucket so the row math reconciles.
    day_stmt = (
        select(
            day_ist,
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
        .group_by(day_ist)
        .order_by(day_ist.desc())
    )
    day_rows = (await db.execute(day_stmt)).all()

    # ---- Campaign-level aggregation ----
    # Same shape but grouped also by campaign_id, then joined to campaigns
    # for the human-readable name. Display_name preferred over raw name —
    # display_name is the user-facing label (synced from Hunar's UI),
    # name is the underlying request id.
    pl_camp = _phone_level_subquery(group_by_campaign=True)
    camp_day_ist = func.date(func.timezone("Asia/Kolkata", pl_camp.c.final_at)).label("day_ist")

    camp_agg = (
        select(
            camp_day_ist,
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
        .group_by(camp_day_ist, pl_camp.c.campaign_id)
    ).subquery()

    camp_name = func.coalesce(Campaign.display_name, Campaign.name).label("campaign_name")

    camp_stmt = (
        select(
            camp_agg.c.day_ist,
            camp_agg.c.campaign_id,
            camp_name,
            camp_agg.c.total_leads,
            camp_agg.c.top_priority,
            camp_agg.c.interested_only,
            camp_agg.c.callback_only,
            camp_agg.c.no_intent,
            camp_agg.c.unreached,
        )
        .join(Campaign, Campaign.id == camp_agg.c.campaign_id, isouter=True)
        .order_by(camp_agg.c.day_ist.desc(), camp_name)
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
