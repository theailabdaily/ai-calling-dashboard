"""DoD Leads — leads grouped by FINAL LEAD STATUS DATE.

Each phone is collapsed to a single row whose date is the calendar day of
its most recent call activity in IST:

    final_at = MAX(COALESCE(ended_at, vendor_created_at)) over all the
               phone's call_logs rows

For a connected call this is the moment the call ended; for a still-
pending lead it falls back to vendor_created_at (the upload time) so
unreached leads still surface on a date.

Bucket semantics are workspace-specific (never cross-contaminate):
  UGC NET → Top Priority / Interested only / Callback only / No Intent
  UPSC    → Hot / Hot Warm / Cold Warm / No Intent
Both are mutually exclusive partitions of connected leads; the same 4
response fields carry the numbers so the schema and frontend keys don't
change — only the labels the frontend shows (driven by workspace cookie).
"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends
from sqlalchemy import and_, case, func, literal, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api._filters import parse_filters
from app.database import get_db
from app.models import CallLog, Campaign
from app.schemas import DodLeadCampaign, DodLeadDay, DodLeadsResponse
from app.services.metrics import MetricFilters

router = APIRouter(prefix="/api/dod-leads", tags=["dod-leads"])


# ---------------------------------------------------------------------------
# Shared predicates — dual-schema so each workspace reads its own fields.
# UGC NET: interest_level / next_step_interest
# UPSC:    upsc_interest_status (or crm_field_16) / call_outcome (or crm_field_19)
# NULL-safe coalesce keeps NOT(signal) = True when the field is absent.
# ---------------------------------------------------------------------------
_is_connected = and_(CallLog.lifecycle_status == "COMPLETED", CallLog.answered_by == "HUMAN")

_is_interested = or_(
    func.coalesce(func.upper(CallLog.result["interest_level"].astext).in_(["HIGH", "MEDIUM"]), False),
    func.coalesce(func.upper(CallLog.result["upsc_interest_status"].astext).in_(["SERIOUS", "EXPLORATORY"]), False),
    func.coalesce(func.upper(CallLog.result["crm_field_16"].astext).in_(["SERIOUS", "EXPLORATORY"]), False),
)
_wants_callback = or_(
    func.coalesce(func.upper(CallLog.result["next_step_interest"].astext) == "CALLBACK", False),
    func.coalesce(func.upper(CallLog.result["call_outcome"].astext).in_(["CALLBACK_REQUESTED", "COUNSELLOR_SCHEDULED"]), False),
    func.coalesce(func.upper(CallLog.result["crm_field_19"].astext).in_(["CALLBACK_REQUESTED", "COUNSELLOR_SCHEDULED"]), False),
)


def _upsc_signal(named: str, crm: str):
    """Coalesce named key + crm_field_N alias, lowercased."""
    return func.lower(func.coalesce(
        CallLog.result[named].astext, CallLog.result[crm].astext
    ))


def _phone_level_subquery(filters: MetricFilters, group_by_campaign: bool):
    """Per-phone aggregation: one row per phone (or phone+campaign) with
    bool_or signals + max duration + final timestamp.

    Includes BOTH UGC and UPSC signals so the caller can apply
    workspace-appropriate bucket logic without a second DB round-trip.

    Workspace/vendor/campaign scoping applied; date NOT applied (the page
    does client-side date picking over the full result set).
    """
    final_at = func.coalesce(CallLog.ended_at, CallLog.vendor_created_at)

    # UPSC crm_field aliases
    _u_int  = _upsc_signal("upsc_interest_status", "crm_field_16")
    _u_out  = _upsc_signal("call_outcome",          "crm_field_19")
    _u_cns  = _upsc_signal("counsellor_scheduled",  "crm_field_21")
    _u_fu   = _upsc_signal("follow_up_required",    "crm_field_23")
    _u_prep = _upsc_signal("preparation_mode",      "crm_field_8")
    _u_wp   = _upsc_signal("working_professional",  "crm_field_13")

    cols = [
        CallLog.mobile_number.label("phone"),
        func.max(final_at).label("final_at"),
        # shared — COALESCE ensures False (not NULL) when all rows miss the condition
        func.coalesce(func.bool_or(_is_connected), False).label("connected"),
        # UGC NET signals
        func.coalesce(func.bool_or(and_(_is_connected, _is_interested)), False).label("interested"),
        func.coalesce(func.bool_or(and_(_is_connected, _wants_callback)), False).label("callback"),
        # UPSC signals — all COALESCE-wrapped so NOT(signal) = True, not NULL
        func.coalesce(func.bool_or(and_(_is_connected, CallLog.engagement_status == "ENGAGED")), False).label("eng"),
        func.coalesce(func.max(
            case((_is_connected, CallLog.duration_seconds), else_=0)
        ), 0).label("max_dur"),
        func.coalesce(func.bool_or(and_(_is_connected, _u_int == "serious")), False).label("serious"),
        func.coalesce(func.bool_or(and_(_is_connected, or_(
            _u_out == "counsellor_scheduled", _u_cns == "true"
        ))), False).label("counsellor"),
        func.coalesce(func.bool_or(and_(_is_connected, _u_fu == "true")), False).label("followup"),
        func.coalesce(func.bool_or(and_(_is_connected, or_(
            _u_prep.in_(["full-time", "side-by-side"]), _u_wp == "true"
        ))), False).label("prep_strong"),
    ]
    group_cols = [CallLog.mobile_number]
    if group_by_campaign:
        cols.append(CallLog.campaign_id.label("campaign_id"))
        group_cols.append(CallLog.campaign_id)

    stmt = select(*cols).where(
        and_(CallLog.mobile_number.isnot(None), CallLog.mobile_number != "")
    )
    stmt = filters.apply(stmt, include_date=False)
    stmt = stmt.group_by(*group_cols)
    return stmt.subquery()


def _bucket_conditions(pl, is_upsc: bool):
    """Return (top_priority_cond, interested_only_cond, callback_only_cond, no_intent_cond).

    UGC NET: 4-signal buckets (interest × callback).
    UPSC:    temperature tiers (engagement × duration × prep × CRM signals).
             Mapped into the same 4 response slots so schema stays unchanged:
               top_priority  → Hot       (engaged + serious/counsellor/followup)
               interested_only → Hot Warm (engaged + >60s + prep, not Hot)
               callback_only  → Cold Warm (engaged, no qualifying signal)
               no_intent      → No Intent (connected but not engaged)
    """
    if is_upsc:
        _hot_sig = or_(pl.c.serious, pl.c.counsellor, pl.c.followup)
        hot       = and_(pl.c.connected, pl.c.eng, _hot_sig)
        hot_warm  = and_(pl.c.connected, pl.c.eng, ~_hot_sig, pl.c.max_dur > 60, pl.c.prep_strong)
        cold_warm = and_(pl.c.connected, pl.c.eng, ~_hot_sig, ~and_(pl.c.max_dur > 60, pl.c.prep_strong))
        no_intent = and_(pl.c.connected, ~pl.c.eng)
        return hot, hot_warm, cold_warm, no_intent
    else:
        tp  = and_(pl.c.connected, pl.c.interested,  pl.c.callback)
        io_ = and_(pl.c.connected, pl.c.interested, ~pl.c.callback)
        co  = and_(pl.c.connected, ~pl.c.interested,  pl.c.callback)
        ni  = and_(pl.c.connected, ~pl.c.interested, ~pl.c.callback)
        return tp, io_, co, ni


@router.get("", response_model=DodLeadsResponse)
async def get_dod_leads(
    db: AsyncSession = Depends(get_db),
    filters: MetricFilters = Depends(parse_filters),
):
    """Return all final-status-days with campaign breakdown, newest first.

    Scoped to the active workspace so UPSC and UGC NET are fully separated.
    UPSC uses Hot/HotWarm/ColdWarm/NoIntent tier logic in the same 4 response
    fields; UGC keeps Top Priority / Interested / Callback / No Intent.
    Date-range is NOT applied server-side — the frontend filters client-side.
    """
    is_upsc = (filters.product_line_slug or "").lower() == "upsc"

    # ---- Day-level aggregation ----
    pl_day  = _phone_level_subquery(filters, group_by_campaign=False)
    t1, i1, c1, n1 = _bucket_conditions(pl_day, is_upsc)
    day_ist = func.date(func.timezone("Asia/Kolkata", pl_day.c.final_at)).label("day_ist")

    day_stmt = (
        select(
            day_ist,
            func.count().label("total_leads"),
            func.count().filter(t1).label("top_priority"),
            func.count().filter(i1).label("interested_only"),
            func.count().filter(c1).label("callback_only"),
            func.count().filter(n1).label("no_intent"),
            func.count().filter(~pl_day.c.connected).label("unreached"),
        )
        .group_by(day_ist)
        .order_by(day_ist.desc())
    )
    day_rows = (await db.execute(day_stmt)).all()

    # ---- Campaign-level aggregation ----
    pl_camp = _phone_level_subquery(filters, group_by_campaign=True)
    t2, i2, c2, n2 = _bucket_conditions(pl_camp, is_upsc)
    camp_day_ist = func.date(func.timezone("Asia/Kolkata", pl_camp.c.final_at)).label("day_ist")

    camp_agg = (
        select(
            camp_day_ist,
            pl_camp.c.campaign_id,
            func.count().label("total_leads"),
            func.count().filter(t2).label("top_priority"),
            func.count().filter(i2).label("interested_only"),
            func.count().filter(c2).label("callback_only"),
            func.count().filter(n2).label("no_intent"),
            func.count().filter(~pl_camp.c.connected).label("unreached"),
        )
        .group_by(camp_day_ist, pl_camp.c.campaign_id)
    ).subquery()

    camp_name = func.coalesce(Campaign.display_name, Campaign.name).label("campaign_name")
    camp_stmt = (
        select(
            camp_agg.c.day_ist, camp_agg.c.campaign_id, camp_name,
            camp_agg.c.total_leads, camp_agg.c.top_priority,
            camp_agg.c.interested_only, camp_agg.c.callback_only,
            camp_agg.c.no_intent, camp_agg.c.unreached,
        )
        .join(Campaign, Campaign.id == camp_agg.c.campaign_id, isouter=True)
        .order_by(camp_agg.c.day_ist.desc(), camp_name)
    )
    camp_rows = (await db.execute(camp_stmt)).all()

    # ---- Stitch campaigns under their date ----
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
