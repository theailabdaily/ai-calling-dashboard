"""Internal endpoints triggered by external cron. Protected by shared secret."""
from __future__ import annotations

import logging

from fastapi import APIRouter, Header, HTTPException

from app.config import get_settings
from app.jobs.sync import sync_all_vendors, sync_one_vendor

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/internal", tags=["internal"])


def _verify_secret(x_cron_secret: str | None) -> None:
    settings = get_settings()
    expected = settings.cron_shared_secret
    if not expected:
        raise HTTPException(status_code=500, detail="cron_shared_secret not configured")
    if not x_cron_secret or x_cron_secret != expected:
        raise HTTPException(status_code=401, detail="invalid or missing X-Cron-Secret")


@router.get("/health")
async def internal_health(x_cron_secret: str | None = Header(default=None)):
    _verify_secret(x_cron_secret)
    return {"status": "ok"}


@router.post("/sync")
async def trigger_sync(x_cron_secret: str | None = Header(default=None)):
    _verify_secret(x_cron_secret)
    logger.info("internal sync triggered")
    await sync_all_vendors()
    return {"status": "ok"}


@router.post("/sync/{vendor_slug}")
async def trigger_sync_one(vendor_slug: str, x_cron_secret: str | None = Header(default=None)):
    _verify_secret(x_cron_secret)
    logger.info("internal sync triggered for vendor=%s", vendor_slug)
    await sync_one_vendor(vendor_slug)
    return {"status": "ok", "vendor": vendor_slug}
