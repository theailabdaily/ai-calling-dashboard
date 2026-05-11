"""Vendors + Campaigns + Agents + manual sync trigger."""
from __future__ import annotations

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api._filters import parse_filters
from app.database import get_db
from app.jobs.sync import sync_one_vendor
from app.models import Agent, Campaign, Vendor
from app.schemas import AgentOut, CampaignOut, CampaignRow, VendorOut, VendorRow
from app.services import metrics
from app.services.metrics import MetricFilters

router = APIRouter(prefix="/api", tags=["vendors"])


@router.get("/vendors", response_model=list[VendorOut])
async def list_vendors(db: AsyncSession = Depends(get_db)):
    rows = (await db.execute(select(Vendor).where(Vendor.is_active.is_(True)).order_by(Vendor.name))).scalars().all()
    return rows


@router.get("/vendors/comparison", response_model=list[VendorRow])
async def vendors_comparison(
    filters: MetricFilters = Depends(parse_filters),
    db: AsyncSession = Depends(get_db),
):
    return await metrics.vendor_comparison(db, filters)


@router.get("/campaigns", response_model=list[CampaignOut])
async def list_campaigns(db: AsyncSession = Depends(get_db)):
    stmt = (
        select(Campaign, Vendor.name.label("vendor_name"))
        .join(Vendor, Vendor.id == Campaign.vendor_id)
        .order_by(Campaign.started_at.desc().nullslast())
    )
    result = await db.execute(stmt)
    out: list[CampaignOut] = []
    for row in result:
        c: Campaign = row[0]
        # Prefer Campaign.display_name (user-set / synced from Hunar UI) over the auto label
        if c.display_name:
            display = c.display_name
        elif c.vendor_campaign_id:
            display = f"Campaign {c.vendor_campaign_id[:8]}"
        else:
            display = f"Campaign {c.vendor_request_id[:8]}"
        out.append(CampaignOut(
            id=c.id,
            name=c.name,
            display_name=display,
            vendor_id=c.vendor_id,
            vendor_name=row.vendor_name,
            vendor_request_id=c.vendor_request_id,
            agent_id=c.agent_id,
            started_at=c.started_at,
            expected_calls=c.expected_calls,
        ))
    return out


@router.get("/campaigns/breakdown", response_model=list[CampaignRow])
async def campaigns_breakdown(
    filters: MetricFilters = Depends(parse_filters),
    db: AsyncSession = Depends(get_db),
):
    return await metrics.campaign_breakdown(db, filters)


@router.get("/agents", response_model=list[AgentOut])
async def list_agents(db: AsyncSession = Depends(get_db)):
    rows = (await db.execute(select(Agent).where(Agent.is_active.is_(True)))).scalars().all()
    return rows


@router.post("/vendors/{slug}/sync")
async def trigger_sync(slug: str, background_tasks: BackgroundTasks):
    """Manual sync trigger. Returns immediately; sync runs in background."""
    try:
        background_tasks.add_task(sync_one_vendor, slug)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"status": "queued", "vendor": slug}
