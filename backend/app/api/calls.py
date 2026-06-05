"""
Calls list + detail endpoints.

The list endpoint is the entry point for QA workflows: filter, search by phone
or name, click into a call. Server-side pagination because we expect 100k+ rows.
"""
from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import and_, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api._filters import parse_filters
from app.database import get_db
from app.models import Agent, CallLog, Campaign, Vendor
from app.schemas import CallDetail, CallListItem, CallListPage
from app.services.metrics import MetricFilters

router = APIRouter(prefix="/api/calls", tags=["calls"])


@router.get("", response_model=CallListPage)
async def list_calls(
    filters: MetricFilters = Depends(parse_filters),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
    search: str | None = Query(None, description="Match against name / phone"),
    status: str | None = Query(None),
    answered_by: str | None = Query(None),
    only_with_recording: bool = Query(False),
    only_interested: bool = Query(False),
    failed_only: bool = Query(False),
    funnel_stage: str | None = Query(None, description="connected | engaged | interested | followup"),
    sort_by: str = Query("when", description="when | duration | status"),
    sort_order: str = Query("desc", description="asc | desc"),
    db: AsyncSession = Depends(get_db),
):
    base = (
        select(
            CallLog,
            Vendor.name.label("vendor_name"),
            func.coalesce(Campaign.display_name, Campaign.name).label("campaign_name"),
            Agent.name.label("agent_name"),
        )
        .join(Vendor, Vendor.id == CallLog.vendor_id)
        .outerjoin(Campaign, Campaign.id == CallLog.campaign_id)
        .outerjoin(Agent, Agent.id == CallLog.agent_id)
    )
    base = filters.apply(base)

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
        # UGC NET uses interest_level HIGH/MEDIUM; UPSC uses upsc_interest_status serious/exploratory
        extra.append(or_(
            func.upper(CallLog.result["interest_level"].astext).in_(["HIGH", "MEDIUM"]),
            func.upper(CallLog.result["upsc_interest_status"].astext).in_(["SERIOUS", "EXPLORATORY"]),
        ))
    if failed_only:
        extra.append(CallLog.status.in_(("FAILED", "NOT_CONNECTED", "CANCELLED")))

    # Funnel stage filter — for the "click on funnel stage" drill-down
    if funnel_stage:
        is_connected = and_(CallLog.lifecycle_status == "COMPLETED", CallLog.answered_by == "HUMAN")
        # Multi-vendor interest signal with NULL-safe coalesce so that
        # ~is_interested is TRUE (not NULL) when both fields are absent.
        # Without coalesce: NOT(NULL IN (...)) = NULL — "no intent" calls
        # with unpopulated results would match nothing.
        #   UGC NET → result.interest_level in (HIGH, MEDIUM)
        #   UPSC    → result.upsc_interest_status in (SERIOUS, EXPLORATORY)
        is_interested = or_(
            func.coalesce(
                func.upper(CallLog.result["interest_level"].astext).in_(["HIGH", "MEDIUM"]),
                False,
            ),
            func.coalesce(
                func.upper(CallLog.result["upsc_interest_status"].astext).in_(["SERIOUS", "EXPLORATORY"]),
                False,
            ),
        )
        # Multi-vendor callback signal (same NULL-safe treatment):
        #   UGC NET → result.next_step_interest == CALLBACK
        #   UPSC    → result.call_outcome in (CALLBACK_REQUESTED, COUNSELLOR_SCHEDULED)
        wants_callback = or_(
            func.coalesce(
                func.upper(CallLog.result["next_step_interest"].astext) == "CALLBACK",
                False,
            ),
            func.coalesce(
                func.upper(CallLog.result["call_outcome"].astext).in_(["CALLBACK_REQUESTED", "COUNSELLOR_SCHEDULED"]),
                False,
            ),
        )

        if funnel_stage == "leads":
            # Top-of-funnel — every lead-attempt in the slice. No filter.
            pass
        elif funnel_stage == "connected":
            extra.append(is_connected)
        elif funnel_stage == "engaged":
            extra.append(and_(is_connected, CallLog.engagement_status == "ENGAGED"))
        elif funnel_stage == "interested":
            # HIGH/MEDIUM interest_level on a connected call.
            extra.append(and_(is_connected, is_interested))
        elif funnel_stage == "callback":
            # Asked for a callback — independent of interest level.
            extra.append(and_(is_connected, wants_callback))
        elif funnel_stage == "top_priority":
            # Interested AND Callback — the lowest-noise sales-actionable list.
            # This is the new bottom-of-funnel stage.
            extra.append(and_(is_connected, is_interested, wants_callback))
        elif funnel_stage == "callback_only":
            # Callback but NOT interested — the "extra 65" leads sales would
            # miss if they only filtered by interest_level. Lower priority
            # but still explicitly asked for contact.
            extra.append(and_(is_connected, wants_callback, ~is_interested))
        elif funnel_stage == "interested_only":
            # Interested (HIGH/MEDIUM) but did NOT ask for a callback.
            # Mutually exclusive with top_priority and callback_only.
            extra.append(and_(is_connected, is_interested, ~wants_callback))
        elif funnel_stage == "no_intent":
            # Connected lead with NO positive signal — not interested AND
            # didn't ask for callback. Includes LOW interest, NOT_COVERED,
            # NOT_AVAILABLE. These are the "had a chance, said no" pool —
            # useful for QA-ing the bot's pitch.
            extra.append(and_(is_connected, ~is_interested, ~wants_callback))
        # Legacy stage names — kept for any bookmarked deep-links from the
        # earlier funnel structure. Behave as their semantic descendants.
        elif funnel_stage == "hotleads":
            # Old union "interested OR callback" — redirect to the new
            # callback stage which is the broader of the two signals.
            extra.append(and_(is_connected, or_(is_interested, wants_callback)))
        elif funnel_stage == "followup":
            extra.append(and_(is_connected, wants_callback))

    if extra:
        base = base.where(and_(*extra))

    # Total count (separate query — we want paginated rows, not all rows)
    count_stmt = select(func.count()).select_from(base.subquery())
    total = (await db.execute(count_stmt)).scalar_one()

    # Sorting — map sort_by name to column. Default to started_at DESC.
    sort_col = {
        "when": CallLog.started_at,
        "duration": CallLog.duration_seconds,
        "status": CallLog.lifecycle_status,
    }.get(sort_by, CallLog.started_at)
    direction = sort_col.asc() if sort_order == "asc" else sort_col.desc()
    if sort_by == "when":
        direction = direction.nullslast() if sort_order == "desc" else direction.nullsfirst()

    rows_stmt = (
        base.order_by(direction)
            .limit(page_size)
            .offset((page - 1) * page_size)
    )
    rows = (await db.execute(rows_stmt)).all()

    items = []
    for row in rows:
        c: CallLog = row[0]
        result_dict = c.result if isinstance(c.result, dict) else {}
        # Interest signal — UGC NET uses interest_level; UPSC uses upsc_interest_status
        interested = result_dict.get("interest_level") or result_dict.get("upsc_interest_status")
        # Follow-up signal — UGC NET uses follow_up_time; UPSC uses call_outcome
        follow_up_raw = result_dict.get("follow_up_time")
        if not follow_up_raw:
            call_outcome = (result_dict.get("call_outcome") or "").upper()
            if call_outcome in ("COUNSELLOR_SCHEDULED", "CALLBACK_REQUESTED"):
                follow_up_raw = result_dict.get("call_outcome")  # show the UPSC outcome string
        # Hunar uses "NA" / "NOT AVAILABLE" / "Not Covered" as null sentinels — collapse those
        follow_up = follow_up_raw if follow_up_raw and follow_up_raw.upper() not in ("NA", "NOT AVAILABLE", "NOT COVERED") else None
        items.append(CallListItem(
            id=c.id,
            vendor_name=row.vendor_name,
            campaign_name=row.campaign_name,
            agent_name=row.agent_name,
            callee_name=c.callee_name,
            mobile_number=c.mobile_number,
            status=c.status,
            lifecycle_status=c.lifecycle_status,
            answered_by=c.answered_by,
            engagement_status=c.engagement_status,
            duration_seconds=float(c.duration_seconds) if c.duration_seconds else None,
            started_at=c.started_at,
            has_recording=bool(c.recording_url),
            interested=str(interested) if interested is not None else None,
            follow_up_at=str(follow_up) if follow_up is not None else None,
        ))

    return CallListPage(items=items, total=int(total or 0), page=page, page_size=page_size)


@router.get("/{call_id}", response_model=CallDetail)
async def get_call(call_id: UUID, db: AsyncSession = Depends(get_db)):
    stmt = (
        select(
            CallLog,
            Vendor.name.label("vendor_name"),
            func.coalesce(Campaign.display_name, Campaign.name).label("campaign_name"),
            Agent.name.label("agent_name"),
        )
        .join(Vendor, Vendor.id == CallLog.vendor_id)
        .outerjoin(Campaign, Campaign.id == CallLog.campaign_id)
        .outerjoin(Agent, Agent.id == CallLog.agent_id)
        .where(CallLog.id == call_id)
    )
    row = (await db.execute(stmt)).first()
    if not row:
        raise HTTPException(status_code=404, detail="Call not found")

    c: CallLog = row[0]
    return CallDetail(
        id=c.id,
        vendor_id=c.vendor_id,
        vendor_name=row.vendor_name,
        vendor_call_id=c.vendor_call_id,
        campaign_id=c.campaign_id,
        campaign_name=row.campaign_name,
        agent_id=c.agent_id,
        agent_name=row.agent_name,
        callee_name=c.callee_name,
        mobile_number=c.mobile_number,
        from_phone_number=c.from_phone_number,
        language=c.language,
        status=c.status,
        lifecycle_status=c.lifecycle_status,
        engagement_status=c.engagement_status,
        answered_by=c.answered_by,
        call_ended_by=c.call_ended_by,
        duration_seconds=float(c.duration_seconds) if c.duration_seconds else None,
        duration_minutes=float(c.duration_minutes) if c.duration_minutes else None,
        user_speech_duration=float(c.user_speech_duration) if c.user_speech_duration else None,
        max_retries=c.max_retries,
        retry_count=c.retry_count,
        retries_left=c.retries_left,
        recording_url=c.recording_url,
        custom_data=c.custom_data or {},
        result=c.result or {},
        started_at=c.started_at,
        ended_at=c.ended_at,
    )
