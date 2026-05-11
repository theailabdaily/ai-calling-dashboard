"""CSV export endpoints.

The export must reflect *exactly* what the user sees in the calls table.
That means honoring every UI filter — top-level (vendor/campaign/dates) AND
in-table (search box, status, pickup, recording, interested-only, failed-only,
funnel stage). If we drop any, the user clicks "Export" expecting the 57 rows
on screen and instead gets thousands. Same filter params and exact same logic
as `app/api/calls.py::list_calls` — when that file changes, this one must
change with it.

Filename + columns:
  - First column is `source` — a friendly label for whichever funnel filter
    produced the file ("Interested + Callback", "Interested only", etc.).
  - Columns 4-6 are `final_lead_status_date` / `final_lead_status_time` /
    `final_lead_status` — the IST date, IST time, and lifecycle of the
    *last call ever made to this lead*, computed across ALL calls (not just
    the filtered set). So even if you export only the "Interested" calls,
    you still see whether the lead later went cold.
  - Filename: `Hunar_<PREFIX>_<ddmmyy>_<HHMM>.csv` where PREFIX is
    INTC / INT / CALLB / LEADS depending on the funnel stage. `Hunar_` prefix
    keeps things tidy when SquadStack exports are added later. Time stamps
    in the filename are IST regardless of the container's TZ.
"""
from __future__ import annotations

import csv
import io
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, Query
from fastapi.responses import StreamingResponse
from sqlalchemy import and_, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api._filters import parse_filters
from app.database import get_db
from app.models import Agent, Campaign, CallLog, Vendor
from app.services.metrics import MetricFilters

router = APIRouter(prefix="/api/export", tags=["export"])

IST = ZoneInfo("Asia/Kolkata")


# Column order: source first, then identity (name + number), then the final-status
# date+time+status trio, then call-level details in roughly the order a BD would
# scan them.
CSV_FIELDS = [
    "source",                    # funnel filter label (Interested + Callback, etc.)
    "callee_name",
    "mobile_number",
    "final_lead_status_date",    # IST date only — e.g. 2026-05-11
    "final_lead_status_time",    # IST time only — e.g. 8:35:02 AM
    "final_lead_status",         # lifecycle_status of the latest call across ALL calls
    "call_id",
    "vendor",
    "campaign",
    "agent",
    "status",
    "lifecycle_status",
    "engagement_status",
    "answered_by",
    "call_ended_by",
    "duration_seconds",
    "duration_minutes",
    "retry_count",
    "max_retries",
    "interest_level",
    "next_step_interest",
    "started_at",
    "ended_at",
    "recording_url",
    "result_json",
]

# Hard cap. With a date window applied this should never trigger; without one,
# someone clicking Export on YTD across all vendors deserves a guard rail.
EXPORT_ROW_CAP = 50000


# Friendly label per funnel_stage value. Shown in the `source` column.
_SOURCE_LABELS = {
    "leads":           "All leads dialled",
    "connected":       "Connected",
    "engaged":         "Engaged",
    "interested":      "Interested (HIGH/MEDIUM)",
    "callback":        "Callback",
    "top_priority":    "Interested + Callback",
    "interested_only": "Interested only",
    "callback_only":   "Callback only",
    "no_intent":       "Connected — no positive signal",
    "hotleads":        "Hot leads (Interested OR Callback)",
    "followup":        "Callback",
}


def _to_ist(dt):
    """Postgres stores timestamps as UTC. If the value comes back naive (no
    tzinfo) we assume UTC. Always return an IST-aware datetime or None."""
    if not dt:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(IST)


def _fmt_date_ist(dt) -> str:
    ist_dt = _to_ist(dt)
    return ist_dt.strftime("%Y-%m-%d") if ist_dt else ""


def _fmt_time_ist(dt) -> str:
    """12-hour clock with AM/PM, no leading zero on hour (e.g. '8:35:02 AM')."""
    ist_dt = _to_ist(dt)
    if not ist_dt:
        return ""
    # %-I is non-zero-padded hour on Linux (Render). On the off-chance this
    # ever runs on Windows the lstrip handles the padded variant.
    try:
        return ist_dt.strftime("%-I:%M:%S %p")
    except ValueError:
        return ist_dt.strftime("%I:%M:%S %p").lstrip("0")


def _filename_for(funnel_stage: str | None) -> str:
    """Filename = Hunar_<PREFIX>_<ddmmyy>_<HHMM>.csv

      INTC   — Interested + Callback (top_priority / hotleads)
      INT    — Interested only / general interested
      CALLB  — Callback only / general callback
      LEADS  — anything else (full set, no funnel-stage filter, etc.)

    Stamp is IST regardless of container TZ.
    """
    stamp = datetime.now(IST).strftime("%d%m%y_%H%M")
    if funnel_stage in ("top_priority", "hotleads"):
        prefix = "INTC"
    elif funnel_stage in ("interested_only", "interested"):
        prefix = "INT"
    elif funnel_stage in ("callback_only", "callback", "followup"):
        prefix = "CALLB"
    else:
        prefix = "LEADS"
    return f"Hunar_{prefix}_{stamp}.csv"


@router.get("/calls.csv")
async def export_calls(
    filters: MetricFilters = Depends(parse_filters),
    # In-table filters — must match calls.py exactly
    search: str | None = Query(None, description="Match against callee_name / mobile_number"),
    status: str | None = Query(None, description="lifecycle_status, e.g. COMPLETED"),
    answered_by: str | None = Query(None, description="HUMAN | MACHINE | UNKNOWN"),
    only_with_recording: bool = Query(False),
    only_interested: bool = Query(False),
    failed_only: bool = Query(False),
    funnel_stage: str | None = Query(None, description="connected | engaged | hotleads (interested/followup are legacy)"),
    db: AsyncSession = Depends(get_db),
):
    # ----------------------------------------------------------------------
    # Latest-call-per-lead subquery. Postgres DISTINCT ON keeps just the row
    # with the most-recent started_at per mobile_number, joined back to the
    # main query so every output row carries the lead's TRUE final status —
    # not the latest-within-filter, which would be misleading.
    # ----------------------------------------------------------------------
    latest_per_lead = (
        select(
            CallLog.mobile_number.label("mobile"),
            CallLog.started_at.label("final_date"),
            CallLog.lifecycle_status.label("final_status"),
        )
        .distinct(CallLog.mobile_number)
        .order_by(CallLog.mobile_number, CallLog.started_at.desc().nullslast())
        .subquery()
    )

    stmt = (
        select(
            CallLog,
            Vendor.name.label("vendor_name"),
            Campaign.name.label("campaign_name"),
            Agent.name.label("agent_name"),
            latest_per_lead.c.final_date,
            latest_per_lead.c.final_status,
        )
        .join(Vendor, Vendor.id == CallLog.vendor_id)
        .outerjoin(Campaign, Campaign.id == CallLog.campaign_id)
        .outerjoin(Agent, Agent.id == CallLog.agent_id)
        .outerjoin(latest_per_lead, latest_per_lead.c.mobile == CallLog.mobile_number)
        .order_by(CallLog.started_at.desc().nullslast())
        .limit(EXPORT_ROW_CAP)
    )
    stmt = filters.apply(stmt)

    extra = []
    if search:
        s = f"%{search}%"
        extra.append(or_(CallLog.callee_name.ilike(s), CallLog.mobile_number.ilike(s)))
    if status:
        extra.append(CallLog.lifecycle_status == status.upper())
    if answered_by:
        extra.append(CallLog.answered_by == answered_by.upper())
    if only_with_recording:
        extra.append(CallLog.recording_url.isnot(None))
    if only_interested:
        extra.append(func.upper(CallLog.result["interest_level"].astext).in_(["HIGH", "MEDIUM"]))
    if failed_only:
        extra.append(CallLog.status.in_(("FAILED", "NOT_CONNECTED", "CANCELLED")))

    # Funnel-stage filter — for the funnel drill-down's "export this stage" link.
    # Same definition as calls.py and metrics.py: connected = COMPLETED + HUMAN.
    if funnel_stage:
        is_connected = and_(CallLog.lifecycle_status == "COMPLETED", CallLog.answered_by == "HUMAN")
        is_interested = func.upper(CallLog.result["interest_level"].astext).in_(["HIGH", "MEDIUM"])
        wants_callback = func.upper(CallLog.result["next_step_interest"].astext) == "CALLBACK"

        if funnel_stage == "leads":
            pass
        elif funnel_stage == "connected":
            extra.append(is_connected)
        elif funnel_stage == "engaged":
            extra.append(and_(is_connected, CallLog.engagement_status == "ENGAGED"))
        elif funnel_stage == "interested":
            extra.append(and_(is_connected, is_interested))
        elif funnel_stage == "callback":
            extra.append(and_(is_connected, wants_callback))
        elif funnel_stage == "top_priority":
            extra.append(and_(is_connected, is_interested, wants_callback))
        elif funnel_stage == "callback_only":
            extra.append(and_(is_connected, wants_callback, ~is_interested))
        elif funnel_stage == "interested_only":
            extra.append(and_(is_connected, is_interested, ~wants_callback))
        elif funnel_stage == "no_intent":
            extra.append(and_(is_connected, ~is_interested, ~wants_callback))
        # Legacy aliases
        elif funnel_stage == "hotleads":
            extra.append(and_(is_connected, or_(is_interested, wants_callback)))
        elif funnel_stage == "followup":
            extra.append(and_(is_connected, wants_callback))

    if extra:
        stmt = stmt.where(and_(*extra))

    source_label = _SOURCE_LABELS.get(funnel_stage or "", "All leads")

    async def gen():
        # Streamed write — avoids materializing the full CSV in memory for
        # large exports. StringIO buffer is reset between rows.
        buf = io.StringIO()
        writer = csv.DictWriter(buf, fieldnames=CSV_FIELDS)
        writer.writeheader()
        yield buf.getvalue()
        buf.seek(0); buf.truncate()

        result = await db.execute(stmt)
        for row in result:
            call: CallLog = row[0]
            interest_level = (call.result or {}).get("interest_level", "") if call.result else ""
            next_step = (call.result or {}).get("next_step_interest", "") if call.result else ""

            writer.writerow({
                "source": source_label,
                "callee_name": call.callee_name or "",
                "mobile_number": call.mobile_number or "",
                "final_lead_status_date": _fmt_date_ist(row.final_date),
                "final_lead_status_time": _fmt_time_ist(row.final_date),
                "final_lead_status": row.final_status or "",
                "call_id": str(call.id),
                "vendor": row.vendor_name,
                "campaign": row.campaign_name or "",
                "agent": row.agent_name or "",
                "status": call.status,
                "lifecycle_status": call.lifecycle_status,
                "engagement_status": call.engagement_status,
                "answered_by": call.answered_by,
                "call_ended_by": call.call_ended_by,
                "duration_seconds": call.duration_seconds or "",
                "duration_minutes": call.duration_minutes or "",
                "retry_count": call.retry_count,
                "max_retries": call.max_retries,
                "interest_level": interest_level,
                "next_step_interest": next_step,
                "started_at": call.started_at.isoformat() if call.started_at else "",
                "ended_at": call.ended_at.isoformat() if call.ended_at else "",
                "recording_url": call.recording_url or "",
                "result_json": str(call.result),
            })
            yield buf.getvalue()
            buf.seek(0); buf.truncate()

    filename = _filename_for(funnel_stage)
    return StreamingResponse(
        gen(),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
