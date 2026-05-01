"""
Sync jobs. Run on cron OR via APScheduler. Both call the same async functions.

Strategy for calls:
  - Find max(vendor_created_at) we already have for this vendor.
  - Subtract a small overlap (5 min) to catch updated-but-already-seen calls.
  - Stream from vendor newest-first; stop when we hit calls older than that.
  - Upsert idempotently.
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.adapters import all_active_adapters, get_adapter
from app.adapters.base import VendorAdapter
from app.database import SessionLocal
from app.models import CallLog, SyncRun, Vendor
from app.services.upsert import get_vendor_by_slug, upsert_agent, upsert_call

logger = logging.getLogger(__name__)

OVERLAP = timedelta(minutes=5)


async def _start_run(db: AsyncSession, vendor_id: UUID | None, job_type: str) -> SyncRun:
    run = SyncRun(vendor_id=vendor_id, job_type=job_type, status="running")
    db.add(run)
    await db.flush()
    return run


async def _finish_run(db: AsyncSession, run: SyncRun, *, status: str, seen: int = 0, upserted: int = 0,
                     hwm: datetime | None = None, error: str | None = None) -> None:
    run.status = status
    run.records_seen = seen
    run.records_upserted = upserted
    run.high_water_mark = hwm
    run.error_message = error
    run.finished_at = datetime.now(timezone.utc)


async def sync_agents_for_vendor(adapter: VendorAdapter) -> None:
    async with SessionLocal() as db:
        vendor = await get_vendor_by_slug(db, adapter.slug)
        if not vendor:
            logger.warning("vendor %s not in DB, skipping agents sync", adapter.slug)
            return
        run = await _start_run(db, vendor.id, "agents")
        try:
            agents = await adapter.list_agents()
            for a in agents:
                await upsert_agent(db, vendor.id, a)
            await _finish_run(db, run, status="success", seen=len(agents), upserted=len(agents))
            await db.commit()
            logger.info("synced %d agents for %s", len(agents), adapter.slug)
        except Exception as e:
            await db.rollback()
            async with SessionLocal() as db2:
                row = (await db2.execute(select(SyncRun).where(SyncRun.id == run.id))).scalar_one()
                await _finish_run(db2, row, status="failed", error=str(e))
                await db2.commit()
            logger.exception("agents sync failed for %s", adapter.slug)


async def sync_calls_for_vendor(adapter: VendorAdapter) -> None:
    async with SessionLocal() as db:
        vendor = await get_vendor_by_slug(db, adapter.slug)
        if not vendor:
            logger.warning("vendor %s not in DB, skipping calls sync", adapter.slug)
            return

        # Determine high-water mark
        hwm_row = await db.execute(
            select(func.max(CallLog.vendor_created_at)).where(CallLog.vendor_id == vendor.id)
        )
        hwm = hwm_row.scalar()
        since = (hwm - OVERLAP) if hwm else None

        run = await _start_run(db, vendor.id, "calls")
        seen = 0
        upserted = 0
        new_hwm = hwm
        try:
            async for normalized in adapter.iter_calls(since=since):
                seen += 1
                await upsert_call(db, vendor.id, normalized)
                upserted += 1
                if normalized.vendor_created_at and (not new_hwm or normalized.vendor_created_at > new_hwm):
                    new_hwm = normalized.vendor_created_at
                # Commit in chunks so a long sync doesn't hold one transaction forever.
                if upserted % 200 == 0:
                    await db.commit()
            await _finish_run(db, run, status="success", seen=seen, upserted=upserted, hwm=new_hwm)
            await db.commit()
            logger.info("synced %d calls for %s (hwm=%s)", upserted, adapter.slug, new_hwm)
        except Exception as e:
            await db.rollback()
            async with SessionLocal() as db2:
                row = (await db2.execute(select(SyncRun).where(SyncRun.id == run.id))).scalar_one()
                await _finish_run(db2, row, status="failed", seen=seen, upserted=upserted, error=str(e))
                await db2.commit()
            logger.exception("calls sync failed for %s", adapter.slug)


async def sync_all_vendors() -> None:
    """Entry point used by APScheduler / cron."""
    for adapter in all_active_adapters():
        await sync_agents_for_vendor(adapter)
        await sync_calls_for_vendor(adapter)


async def sync_one_vendor(slug: str) -> None:
    adapter = get_adapter(slug)
    await sync_agents_for_vendor(adapter)
    await sync_calls_for_vendor(adapter)
