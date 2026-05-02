"""Activity log / ledger — operational journal for the marketing team.

GET /api/ledger              — paginated list, filterable by type/vendor/date
POST /api/ledger             — create a new entry
PATCH /api/ledger/{id}       — partial update
DELETE /api/ledger/{id}      — hard delete (cheap — these are audit notes,
                                rare to delete; if soft-delete becomes a
                                requirement we add a deleted_at column)

When an entry has campaign_id set, the response includes a `live_stats` block
joined from call_logs so the UI can show "you logged 500 leads sent →
vendor dialed 487 → connected 152" in one row.
"""
from __future__ import annotations

from datetime import datetime
from typing import Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import and_, case, func, literal, select
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
            campaign_name = c.name
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
# Routes
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

    # Total — for pagination footer
    total_stmt = select(func.count()).select_from(LedgerEntry).where(where)
    total = int((await db.execute(total_stmt)).scalar() or 0)

    # Page of entries
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
