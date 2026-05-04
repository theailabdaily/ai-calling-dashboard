"""CSV export endpoints.

The export must reflect *exactly* what the user sees in the calls table.
That means honoring every UI filter — top-level (vendor/campaign/dates) AND
in-table (search box, status, pickup, recording, interested-only, failed-only,
funnel stage). If we drop any, the user clicks "Export" expecting the 57 rows
on screen and instead gets thousands. Same filter params and exact same logic
as `app/api/calls.py::list_calls` — when that file changes, this one must
change with it.
"""
from __future__ import annotations

import csv
import io

from fastapi import APIRouter, Depends, Query
from fastapi.responses import StreamingResponse
from sqlalchemy import and_, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api._filters import parse_filters
from app.database import get_db
from app.models import Agent, Campaign, CallLog, Vendor
from app.services.metrics import MetricFilters

router = APIRouter(prefix="/api/export", tags=["export"])


# Agent column added because it appears in the on-screen table — keeps
# the CSV in step with what users actually see.
CSV_FIELDS = [
    "call_id", "vendor", "campaign", "agent", "callee_name", "mobile_number",
    "status", "lifecycle_status", "engagement_status", "answered_by", "call_ended_by",
    "duration_seconds", "duration_minutes", "retry_count", "max_retries",
    "interest_level", "next_step_interest",
    "started_at", "ended_at", "recording_url", "result_json",
]

# Hard cap. With a date window applied this should never trigger; without one,
# someone clicking Export on YTD across all vendors deserves a guard rail.
EXPORT_ROW_CAP = 50000


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
    stmt = (
        select(
            CallLog,
            Vendor.name.label("vendor_name"),
            Campaign.name.label("campaign_name"),
            Agent.name.label("agent_name"),
        )
        .join(Vendor, Vendor.id == CallLog.vendor_id)
        .outerjoin(Campaign, Campaign.id == CallLog.campaign_id)
        .outerjoin(Agent, Agent.id == CallLog.agent_id)
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
            # Pull qualitative result fields out as their own columns —
            # easier to filter in Excel than digging through result_json.
            interest_level = (call.result or {}).get("interest_level", "") if call.result else ""
            next_step = (call.result or {}).get("next_step_interest", "") if call.result else ""
            writer.writerow({
                "call_id": str(call.id),
                "vendor": row.vendor_name,
                "campaign": row.campaign_name or "",
                "agent": row.agent_name or "",
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
                "interest_level": interest_level,
                "next_step_interest": next_step,
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
