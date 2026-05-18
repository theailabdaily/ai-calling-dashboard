"""Admin endpoints — protected at the frontend layer (NextAuth session).

These endpoints don't currently re-validate auth at the backend level. The
frontend's NextAuth middleware gates the corresponding pages (/admin/*),
and the backend trusts the frontend.

(If we ever expose the API beyond a single first-party frontend, we'll
add a JWT validation here that checks the NextAuth session token.)
"""
from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models import AuthEvent

router = APIRouter(prefix="/api/admin", tags=["admin"])


class AuthEventOut(BaseModel):
    id: str
    email: str
    event: str
    ip: str | None
    user_agent: str | None
    occurred_at: datetime


@router.get("/auth-events", response_model=list[AuthEventOut])
async def list_auth_events(
    limit: int = Query(50, ge=1, le=500),
    db: AsyncSession = Depends(get_db),
):
    """Most recent first."""
    stmt = (
        select(AuthEvent)
        .order_by(AuthEvent.occurred_at.desc())
        .limit(limit)
    )
    rows = (await db.execute(stmt)).scalars().all()
    return [
        AuthEventOut(
            id=str(r.id),
            email=r.email,
            event=r.event,
            ip=r.ip,
            user_agent=r.user_agent,
            occurred_at=r.occurred_at,
        )
        for r in rows
    ]
