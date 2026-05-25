"""Adapter registry. Look up by vendor slug."""
from __future__ import annotations

from app.adapters.base import VendorAdapter
from app.adapters.hunar import HunarAdapter
from app.adapters.squadstack import SquadStackAdapter
from app.config import get_settings


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
    if s.hunar_upsc_api_key:
        # Second Hunar adapter for the UPSC bot — separate org, separate API key,
        # syncs under slug "hunar-upsc" so its vendor row and call_logs never
        # mix with the UGC NET data.
        out.append(HunarAdapter(
            api_key=s.hunar_upsc_api_key,
            base_url=s.hunar_upsc_base_url,
            slug="hunar-upsc",
            display_name="Hunar (UPSC)",
        ))
    if s.squadstack_api_key:
        out.append(SquadStackAdapter(api_key=s.squadstack_api_key, base_url=s.squadstack_base_url))
    return out
