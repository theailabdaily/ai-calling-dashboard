"""Activity log / ledger — operational journal for the marketing team.

GET /api/ledger                          — paginated list, filterable
GET /api/ledger/pending-campaigns        — campaigns with no ledger entry yet
GET /api/ledger/campaign-stats/{id}      — live stats for a single campaign
                                           (used by the form to auto-fill
                                           unique-leads when a campaign is picked)
POST /api/ledger                         — create a new entry
PATCH /api/ledger/{id}                   — partial update
DELETE /api/ledger/{id}                  — hard delete

When an entry has campaign_id set, the response includes a `live_stats` block
joined from call_logs so the UI can show "you logged 500 leads sent →
vendor dialed 487 → connected 152" in one row.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import and_, func, literal, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models import Campaign, CallLog, LedgerEntry, Vendor
from app.schemas import (
    LEDGER_ENTRY_TYPES,
    LedgerEntryIn,
    LedgerEntryOut,
    LedgerEntryUpdate,
    LedgerListResponse,
    LedgerLiveStats,
    PendingCampaign,
    PendingCampaignsResponse,
)

router = APIRouter(prefix="/api/ledger", tags=["ledger"])


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _validate_type(t: str) -> None:
    if t not in LEDGER_ENTRY_TYPES:
        raise HTTPException(
            status_code=400,
            detail=f"entry_type must be one of {LEDGER_ENTRY_TYPES}",
        )


async def _live_stats_for_campaign(db: AsyncSession, campaign_id: UUID) -> LedgerLiveStats:
    """One round-trip to compute the dialed/connected/interested numbers for
    the campaign linked to this ledger entry. Used to show the user 'what I
    sent vs what actually happened' in a single row."""
    is_connected = and_(
        CallLog.lifecycle_status == "COMPLETED",
        CallLog.answered_by == "HUMAN",
    )
    # Hunar interest_level convention — same as in services/metrics.py
    is_interested = func.upper(CallLog.result["interest_level"].astext).in_(["HIGH", "MEDIUM"])

    stmt = select(
        func.count().label("total_calls"),
        func.count(func.distinct(CallLog.mobile_number)).filter(
            and_(CallLog.mobile_number.isnot(None), CallLog.mobile_number != "")
        ).label("unique_leads"),
        func.count().filter(is_connected).label("connected"),
        func.count().filter(and_(is_connected, is_interested)).label("interested"),
        func.coalesce(func.avg(CallLog.duration_seconds).filter(is_connected), 0.0).label("avg_dur"),
    ).where(CallLog.campaign_id == campaign_id)

    row = (await db.execute(stmt)).one()
    return LedgerLiveStats(
        total_calls=int(row.total_calls or 0),
        unique_leads=int(row.unique_leads or 0),
        connected=int(row.connected or 0),
        interested=int(row.interested or 0),
        avg_duration_seconds=float(row.avg_dur or 0.0),
    )


async def _serialize(db: AsyncSession, entry: LedgerEntry) -> LedgerEntryOut:
    """Build a response model with denormalized vendor/campaign names + live stats."""
    vendor_name: str | None = None
    campaign_name: str | None = None
    campaign_vendor_request_id: str | None = None
    live_stats: LedgerLiveStats | None = None

    if entry.vendor_id:
        v = (await db.execute(select(Vendor).where(Vendor.id == entry.vendor_id))).scalar_one_or_none()
        vendor_name = v.name if v else None

    if entry.campaign_id:
        c = (await db.execute(select(Campaign).where(Campaign.id == entry.campaign_id))).scalar_one_or_none()
         if c:
            campaign_name = c.display_name or c.name
            campaign_vendor_request_id = c.vendor_request_id
        live_stats = await _live_stats_for_campaign(db, entry.campaign_id)

    return LedgerEntryOut(
        id=entry.id,
        entry_type=entry.entry_type,
        title=entry.title,
        occurred_at=entry.occurred_at,
        vendor_id=entry.vendor_id,
        vendor_name=vendor_name,
        campaign_id=entry.campaign_id,
        campaign_name=campaign_name,
        campaign_vendor_request_id=campaign_vendor_request_id,
        leads_total=entry.leads_total,
        leads_unique=entry.leads_unique,
        notes=entry.notes,
        metadata=entry.metadata_ or {},
        live_stats=live_stats,
        created_at=entry.created_at,
        updated_at=entry.updated_at,
    )


# ---------------------------------------------------------------------------
# Specific GETs first — must come before /{entry_id} catch-alls in case we
# ever add a GET-by-id endpoint. Keeps router precedence unambiguous.
# ---------------------------------------------------------------------------
@router.get("/pending-campaigns", response_model=PendingCampaignsResponse)
async def pending_campaigns(
    days: int = Query(30, ge=1, le=365, description="only flag campaigns newer than this"),
    db: AsyncSession = Depends(get_db),
):
    """Campaigns that exist but have no ledger entry attached yet.

    The marketing team's contract is: every campaign should have at least
    one journal entry (typically a 'leads_given' or 'campaign_created').
    Anything without one is operational debt — surface it loudly.

    We cap to the last N days because pre-history campaigns aren't worth
    backfilling notes for.
    """
    # Subquery: campaign_ids that already appear in any ledger entry
    logged = (
        select(LedgerEntry.campaign_id)
        .where(LedgerEntry.campaign_id.isnot(None))
        .subquery()
    )

    # Aggregate live stats per campaign in one go — avoids N+1 when there are
    # many pending. We only need unique_leads + total_calls for the form's
    # auto-fill; the full LedgerLiveStats is overkill here.
    cutoff = datetime.now(timezone.utc) - timedelta(days=days)

    stmt = (
        select(
            Campaign.id,
            Campaign.name,
            Campaign.display_name,
            Campaign.vendor_id,
            Vendor.name.label("vendor_name"),
            Campaign.vendor_request_id,
            Campaign.started_at,
            Campaign.expected_calls,
            func.count(CallLog.id).label("total_calls"),
            func.count(func.distinct(CallLog.mobile_number)).filter(
                and_(CallLog.mobile_number.isnot(None), CallLog.mobile_number != "")
            ).label("unique_leads"),
        )
        .join(Vendor, Vendor.id == Campaign.vendor_id)
        .outerjoin(CallLog, CallLog.campaign_id == Campaign.id)
        .where(Campaign.id.notin_(select(logged)))
        .where(
            # use started_at when present, else created_at as the cohort filter
            func.coalesce(Campaign.started_at, Campaign.created_at) >= cutoff
        )
        .group_by(
            Campaign.id, Campaign.name, Campaign.display_name, Campaign.vendor_id, Vendor.name,
            Campaign.vendor_request_id, Campaign.started_at, Campaign.expected_calls,
        )
        .order_by(func.coalesce(Campaign.started_at, Campaign.created_at).desc())
    )

    rows = (await db.execute(stmt)).all()
    items = [
        PendingCampaign(
            campaign_id=r.id,
            campaign_name=r.display_name or r.name,
            vendor_id=r.vendor_id,
            vendor_name=r.vendor_name,
            vendor_request_id=r.vendor_request_id,
            started_at=r.started_at,
            expected_calls=r.expected_calls,
            total_calls=int(r.total_calls or 0),
            unique_leads=int(r.unique_leads or 0),
        )
        for r in rows
    ]
    return PendingCampaignsResponse(items=items, total=len(items), days=days)


@router.get("/campaign-stats/{campaign_id}", response_model=LedgerLiveStats)
async def campaign_stats(campaign_id: UUID, db: AsyncSession = Depends(get_db)):
    """Live stats for a single campaign — used by the New Entry form to
    auto-populate leads_total/leads_unique when the user picks a campaign."""
    exists = (await db.execute(select(Campaign.id).where(Campaign.id == campaign_id))).scalar_one_or_none()
    if not exists:
        raise HTTPException(status_code=404, detail="campaign not found")
    return await _live_stats_for_campaign(db, campaign_id)


# ---------------------------------------------------------------------------
# List + CRUD
# ---------------------------------------------------------------------------
@router.get("", response_model=LedgerListResponse)
async def list_entries(
    entry_type: str | None = Query(None),
    vendor_id: UUID | None = Query(None),
    campaign_id: UUID | None = Query(None),
    start: datetime | None = Query(None),
    end: datetime | None = Query(None),
    search: str | None = Query(None, min_length=1, max_length=200),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    db: AsyncSession = Depends(get_db),
):
    """List ledger entries, newest-first. Filters compose with AND."""
    conds: list[Any] = []
    if entry_type:
        _validate_type(entry_type)
        conds.append(LedgerEntry.entry_type == entry_type)
    if vendor_id:
        conds.append(LedgerEntry.vendor_id == vendor_id)
    if campaign_id:
        conds.append(LedgerEntry.campaign_id == campaign_id)
    if start:
        conds.append(LedgerEntry.occurred_at >= start)
    if end:
        conds.append(LedgerEntry.occurred_at <= end)
    if search:
        like = f"%{search}%"
        conds.append(
            (LedgerEntry.title.ilike(like)) | (LedgerEntry.notes.ilike(like))
        )

    where = and_(*conds) if conds else literal(True)

    total_stmt = select(func.count()).select_from(LedgerEntry).where(where)
    total = int((await db.execute(total_stmt)).scalar() or 0)

    offset = (page - 1) * page_size
    stmt = (
        select(LedgerEntry)
        .where(where)
        .order_by(LedgerEntry.occurred_at.desc(), LedgerEntry.created_at.desc())
        .offset(offset)
        .limit(page_size)
    )
    rows = (await db.execute(stmt)).scalars().all()
    items = [await _serialize(db, e) for e in rows]

    return LedgerListResponse(items=items, total=total, page=page, page_size=page_size)


@router.post("", response_model=LedgerEntryOut, status_code=201)
async def create_entry(body: LedgerEntryIn, db: AsyncSession = Depends(get_db)):
    _validate_type(body.entry_type)
    if not body.title.strip():
        raise HTTPException(status_code=400, detail="title cannot be empty")

    entry = LedgerEntry(
        entry_type=body.entry_type,
        title=body.title.strip(),
        occurred_at=body.occurred_at or func.now(),
        vendor_id=body.vendor_id,
        campaign_id=body.campaign_id,
        leads_total=body.leads_total,
        leads_unique=body.leads_unique,
        notes=body.notes,
        metadata_=body.metadata or {},
    )
    db.add(entry)
    await db.commit()
    await db.refresh(entry)
    return await _serialize(db, entry)


@router.patch("/{entry_id}", response_model=LedgerEntryOut)
async def update_entry(
    entry_id: UUID,
    body: LedgerEntryUpdate,
    db: AsyncSession = Depends(get_db),
):
    entry = (await db.execute(select(LedgerEntry).where(LedgerEntry.id == entry_id))).scalar_one_or_none()
    if not entry:
        raise HTTPException(status_code=404, detail="entry not found")

    if body.entry_type is not None:
        _validate_type(body.entry_type)
        entry.entry_type = body.entry_type
    if body.title is not None:
        if not body.title.strip():
            raise HTTPException(status_code=400, detail="title cannot be empty")
        entry.title = body.title.strip()
    if body.occurred_at is not None:
        entry.occurred_at = body.occurred_at
    if body.vendor_id is not None:
        entry.vendor_id = body.vendor_id
    if body.campaign_id is not None:
        entry.campaign_id = body.campaign_id
    if body.leads_total is not None:
        entry.leads_total = body.leads_total
    if body.leads_unique is not None:
        entry.leads_unique = body.leads_unique
    if body.notes is not None:
        entry.notes = body.notes
    if body.metadata is not None:
        entry.metadata_ = body.metadata

    await db.commit()
    await db.refresh(entry)
    return await _serialize(db, entry)


@router.delete("/{entry_id}", status_code=204)
async def delete_entry(entry_id: UUID, db: AsyncSession = Depends(get_db)):
    entry = (await db.execute(select(LedgerEntry).where(LedgerEntry.id == entry_id))).scalar_one_or_none()
    if not entry:
        raise HTTPException(status_code=404, detail="entry not found")
    await db.delete(entry)
    await db.commit()
    return None
