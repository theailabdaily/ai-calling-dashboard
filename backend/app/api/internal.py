"""Internal endpoints triggered by external cron + auth. Protected by shared secrets."""
from __future__ import annotations

import logging
from datetime import datetime

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.database import get_db
from app.jobs.sync import sync_all_vendors, sync_one_vendor
from app.models import AuthEvent

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/internal", tags=["internal"])


def _verify_secret(x_cron_secret: str | None) -> None:
    settings = get_settings()
    expected = settings.cron_shared_secret
    if not expected:
        raise HTTPException(status_code=500, detail="cron_shared_secret not configured")
    if not x_cron_secret or x_cron_secret != expected:
        raise HTTPException(status_code=401, detail="invalid or missing X-Cron-Secret")


def _verify_auth_log_secret(x_auth_log_secret: str | None) -> None:
    settings = get_settings()
    expected = settings.auth_log_secret
    if not expected:
        raise HTTPException(status_code=500, detail="auth_log_secret not configured")
    if not x_auth_log_secret or x_auth_log_secret != expected:
        raise HTTPException(status_code=401, detail="invalid or missing X-Auth-Log-Secret")


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


# ---------------------------------------------------------------------------
# Auth events — written by NextAuth on signIn/signOut callbacks
# ---------------------------------------------------------------------------
class AuthEventIn(BaseModel):
    email: str
    event: str   # 'signin_success' | 'signin_blocked_non_testbook' | 'signout' | 'signin_error'
    ip: str | None = None
    user_agent: str | None = None


@router.post("/auth-events")
async def log_auth_event(
    body: AuthEventIn,
    x_auth_log_secret: str | None = Header(default=None),
    db: AsyncSession = Depends(get_db),
):
    _verify_auth_log_secret(x_auth_log_secret)
    db.add(AuthEvent(
        email=body.email,
        event=body.event,
        ip=body.ip,
        user_agent=body.user_agent,
    ))
    await db.commit()
    return {"status": "logged"}
