"""Adapter registry. Look up by vendor slug."""
from __future__ import annotations

import logging

from app.adapters.base import VendorAdapter
from app.adapters.hunar import HunarAdapter
from app.adapters.squadstack import SquadStackAdapter
from app.config import get_settings

logger = logging.getLogger(__name__)


def get_adapter(slug: str) -> VendorAdapter:
    """Return a configured adapter for the given vendor slug."""
    s = get_settings()
    if slug == "hunar":
        if not s.hunar_api_key:
            raise RuntimeError("HUNAR_API_KEY not configured")
        return HunarAdapter(api_key=s.hunar_api_key, base_url=s.hunar_base_url)
    if slug == "hunar-upsc":
        if not s.hunar_upsc_api_key:
            raise RuntimeError("HUNAR_UPSC_API_KEY not configured")
        return HunarAdapter(
            api_key=s.hunar_upsc_api_key,
            base_url=s.hunar_upsc_base_url,
            slug="hunar-upsc",
            display_name="Hunar (UPSC)",
        )
    if slug == "squadstack":
        return SquadStackAdapter(api_key=s.squadstack_api_key, base_url=s.squadstack_base_url)
    raise ValueError(f"Unknown vendor slug: {slug}")


def all_active_adapters() -> list[VendorAdapter]:
    """Return adapters for every vendor that has credentials configured."""
    s = get_settings()
    out: list[VendorAdapter] = []
    if s.hunar_api_key:
        out.append(HunarAdapter(api_key=s.hunar_api_key, base_url=s.hunar_base_url))
        logger.info("adapter active: hunar (UGC NET)")
    else:
        logger.warning("adapter SKIPPED: hunar -- HUNAR_API_KEY not set")

    if s.hunar_upsc_api_key:
        out.append(HunarAdapter(
            api_key=s.hunar_upsc_api_key,
            base_url=s.hunar_upsc_base_url,
            slug="hunar-upsc",
            display_name="Hunar (UPSC)",
        ))
        logger.info("adapter active: hunar-upsc (UPSC)")
    else:
        logger.warning("adapter SKIPPED: hunar-upsc -- HUNAR_UPSC_API_KEY not set or empty")

    if s.squadstack_api_key:
        out.append(SquadStackAdapter(api_key=s.squadstack_api_key, base_url=s.squadstack_base_url))
        logger.info("adapter active: squadstack")

    logger.info("total active adapters: %d", len(out))
    return out
