"""Hourly insights API — single endpoint, full payload."""
from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.api._filters import parse_filters
from app.database import get_db
from app.schemas import HourlyInsights
from app.services import metrics
from app.services.metrics import MetricFilters

router = APIRouter(prefix="/api/hourly", tags=["hourly"])


@router.get("/insights", response_model=HourlyInsights)
async def get_hourly_insights(
    filters: MetricFilters = Depends(parse_filters),
    db: AsyncSession = Depends(get_db),
):
    return await metrics.hourly_insights(db, filters)
