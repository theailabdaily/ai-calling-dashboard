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
    db: AsyncSession = Depends(get_db),
):
    base = (
        select(
            CallLog,
            Vendor.name.label("vendor_name"),
            Campaign.name.label("campaign_name"),
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
        extra.append(func.lower(CallLog.result["interested"].astext).in_(["yes", "true", "interested"]))
    if extra:
        base = base.where(and_(*extra))

    # Total count (separate query — we want paginated rows, not all rows)
    count_stmt = select(func.count()).select_from(base.subquery())
    total = (await db.execute(count_stmt)).scalar_one()

    rows_stmt = (
        base.order_by(CallLog.started_at.desc().nullslast())
            .limit(page_size)
            .offset((page - 1) * page_size)
    )
    rows = (await db.execute(rows_stmt)).all()

    items = []
    for row in rows:
        c: CallLog = row[0]
        interested = c.result.get("interested") if isinstance(c.result, dict) else None
        follow_up = c.result.get("follow_up_at") if isinstance(c.result, dict) else None
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
            Campaign.name.label("campaign_name"),
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
