"""Per-agent performance breakdown."""
from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.api._filters import parse_filters
from app.database import get_db
from app.schemas import AgentPerformanceRow
from app.services import metrics
from app.services.metrics import MetricFilters

router = APIRouter(prefix="/api/agents", tags=["agents"])


@router.get("/performance", response_model=list[AgentPerformanceRow])
async def agent_performance(
    filters: MetricFilters = Depends(parse_filters),
    db: AsyncSession = Depends(get_db),
):
    return await metrics.agent_breakdown(db, filters)
