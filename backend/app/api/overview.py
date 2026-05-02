"""Overview dashboard API."""
from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.api._filters import parse_filters
from app.database import get_db
from app.schemas import FunnelStage, HourBucket, OverviewMetrics, TimeBucket, VendorRow
from app.services import metrics
from app.services.metrics import MetricFilters

router = APIRouter(prefix="/api/overview", tags=["overview"])


@router.get("/metrics", response_model=OverviewMetrics)
async def get_metrics(
    filters: MetricFilters = Depends(parse_filters),
    db: AsyncSession = Depends(get_db),
):
    return await metrics.compute_overview_metrics(db, filters)


@router.get("/time-series", response_model=list[TimeBucket])
async def get_time_series(
    bucket: str = "day",
    filters: MetricFilters = Depends(parse_filters),
    db: AsyncSession = Depends(get_db),
):
    if bucket not in ("hour", "day", "week", "month"):
        bucket = "day"
    return await metrics.calls_over_time(db, filters, bucket=bucket)


@router.get("/funnel", response_model=list[FunnelStage])
async def get_funnel(
    filters: MetricFilters = Depends(parse_filters),
    db: AsyncSession = Depends(get_db),
):
    return await metrics.call_funnel(db, filters)


@router.get("/vendor-comparison", response_model=list[VendorRow])
async def get_vendor_comparison(
    filters: MetricFilters = Depends(parse_filters),
    db: AsyncSession = Depends(get_db),
):
    return await metrics.vendor_comparison(db, filters)


@router.get("/hourly", response_model=list[HourBucket])
async def get_hourly(
    filters: MetricFilters = Depends(parse_filters),
    db: AsyncSession = Depends(get_db),
):
    return await metrics.hourly_breakdown(db, filters)
