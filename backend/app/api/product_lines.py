"""Product lines (categories) — the picker reads from here.

A product line groups one or more agents (e.g. UGC NET, UPSC, future Banking).
Each agent in the `agents` table has a `product_line_id` FK; queries scope to
a line by joining through. The picker shows one card per line with rollup stats.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models import Agent, CallLog, Campaign, ProductLine

router = APIRouter(prefix="/api", tags=["product-lines"])


class ProductLineCard(BaseModel):
    slug: str
    name: str
    description: str | None = None
    color: str | None = None
    agent_count: int = 0
    total_calls: int = 0           # last 30 days
    total_campaigns: int = 0       # last 30 days
    last_call_at: datetime | None = None
    status: str = "not_started"    # "live" | "idle" | "not_started"


@router.get("/product-lines", response_model=list[ProductLineCard])
async def list_product_lines(db: AsyncSession = Depends(get_db)):
    """
    Returns one card per product line with rollup stats for the picker.
    Stats use the last 30 days as the window — purely for display, not filtering.
    The real "live" indicator is whether any call has happened in the last 24h.
    """
    # Pull lines with their agent counts in one query
    lines_stmt = (
        select(
            ProductLine.id,
            ProductLine.slug,
            ProductLine.name,
            ProductLine.description,
            ProductLine.color,
            func.count(Agent.id).label("agent_count"),
        )
        .outerjoin(Agent, Agent.product_line_id == ProductLine.id)
        .group_by(ProductLine.id, ProductLine.slug, ProductLine.name, ProductLine.description, ProductLine.color)
        .order_by(ProductLine.name)
    )
    rows = (await db.execute(lines_stmt)).all()

    out: list[ProductLineCard] = []
    for r in rows:
        # For each line, fetch its rollup stats. Could be a single mega-query
        # but with ≤10 product lines the round-trip overhead is negligible and
        # the per-line query is much easier to maintain.
        agent_ids_sq = (
            select(Agent.id).where(Agent.product_line_id == r.id)
        )
        stats_stmt = select(
            func.count(CallLog.id).label("calls"),
            func.count(func.distinct(CallLog.campaign_id)).label("campaigns"),
            func.max(CallLog.ended_at).label("last_call"),
        ).where(CallLog.agent_id.in_(agent_ids_sq))
        s = (await db.execute(stats_stmt)).one()

        last_call = s.last_call
        if last_call is None:
            status = "not_started"
        else:
            age_hours = (datetime.now(last_call.tzinfo) - last_call).total_seconds() / 3600
            status = "live" if age_hours < 24 else "idle"

        out.append(ProductLineCard(
            slug=r.slug,
            name=r.name,
            description=r.description,
            color=r.color,
            agent_count=int(r.agent_count or 0),
            total_calls=int(s.calls or 0),
            total_campaigns=int(s.campaigns or 0),
            last_call_at=last_call,
            status=status,
        ))
    return out
