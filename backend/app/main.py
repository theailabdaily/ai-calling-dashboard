"""FastAPI app entry point."""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.interval import IntervalTrigger
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api import agents, calls, exports, hourly, ingestion, ledger, overview, vendors
from app.config import get_settings
from app.jobs.sync import sync_all_vendors

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s -- %(message)s")
logger = logging.getLogger(__name__)

settings = get_settings()
scheduler = AsyncIOScheduler()


@asynccontextmanager
async def lifespan(app: FastAPI):
    if settings.disable_internal_scheduler:
        logger.info("internal scheduler disabled -- relying on external cron")
    else:
        scheduler.add_job(
            sync_all_vendors,
            IntervalTrigger(minutes=settings.sync_calls_interval_minutes),
            id="sync_all_vendors",
            replace_existing=True,
        )
        scheduler.start()
        logger.info("scheduler started; sync every %s min", settings.sync_calls_interval_minutes)
    yield
    if scheduler.running:
        scheduler.shutdown(wait=False)


app = FastAPI(title=settings.app_name, lifespan=lifespan)

# CORS middleware -- must be added before any others so it wraps exception responses.
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["*"],
)

app.include_router(overview.router)
app.include_router(vendors.router)
app.include_router(calls.router)
app.include_router(agents.router)
app.include_router(exports.router)
app.include_router(ingestion.router)
app.include_router(hourly.router)
app.include_router(ledger.router)


@app.get("/health")
async def health():
    return {"status": "ok", "env": settings.environment}


@app.get("/")
async def root():
    return {"service": settings.app_name, "status": "ok"}
