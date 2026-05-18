"""Common filter parsing for API endpoints."""
from __future__ import annotations

from datetime import datetime
from uuid import UUID

from fastapi import Query

from app.services.metrics import MetricFilters, default_window


def _parse_uuid_list(values: list[str] | None) -> list[UUID] | None:
    if not values:
        return None
    out: list[UUID] = []
    for v in values:
        for part in v.split(","):
            part = part.strip()
            if part:
                out.append(UUID(part))
    return out or None


def parse_filters(
    start: datetime | None = Query(None),
    end: datetime | None = Query(None),
    vendor_ids: list[str] | None = Query(None),
    campaign_ids: list[str] | None = Query(None),
    agent_ids: list[str] | None = Query(None),
    product_line: str | None = Query(None, description="Filter to one product line by slug (e.g. 'ugc-net', 'upsc')"),
) -> MetricFilters:
    if not start or not end:
        ds, de = default_window()
        start = start or ds
        end = end or de
    return MetricFilters(
        start=start,
        end=end,
        vendor_ids=_parse_uuid_list(vendor_ids),
        campaign_ids=_parse_uuid_list(campaign_ids),
        agent_ids=_parse_uuid_list(agent_ids),
        product_line_slug=product_line.strip() if product_line and product_line.strip() else None,
    )
