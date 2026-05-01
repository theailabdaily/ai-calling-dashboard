"""
SquadStack adapter — STUB.

Fill in once you have SquadStack API credentials and docs. The whole point
of the adapter pattern is that everything outside this file stays untouched
when you add SquadStack.

Steps to integrate:
  1. Replace the API endpoints below with real ones from SquadStack's docs.
  2. Map their status values into our normalized CALL_STATUS_VALUES.
  3. Map their result/outcome shape into NormalizedCall.result.
  4. Add SQUADSTACK_API_KEY to .env and config.py (already stubbed).
  5. Register this adapter in app/adapters/__init__.py (already stubbed).
  6. Run sync — the rest of the system "just works".
"""
from __future__ import annotations

from collections.abc import AsyncIterator
from datetime import datetime
from typing import Any

from app.adapters.base import NormalizedAgent, NormalizedCall, VendorAdapter


class SquadStackAdapter(VendorAdapter):
    slug = "squadstack"
    display_name = "SquadStack"

    def __init__(self, api_key: str | None, base_url: str | None = None) -> None:
        self.api_key = api_key
        self.base_url = (base_url or "").rstrip("/")

    async def list_agents(self) -> list[NormalizedAgent]:
        # TODO: GET <base>/<agents-endpoint>
        return []

    async def iter_calls(
        self,
        *,
        since: datetime | None = None,
        page_size: int = 200,
    ) -> AsyncIterator[NormalizedCall]:
        # TODO: GET <base>/<calls-endpoint> paginated, normalize each row.
        if False:
            yield  # type: ignore[unreachable]
        return

    async def get_call(self, vendor_call_id: str) -> NormalizedCall | None:
        # TODO
        return None

    def parse_webhook(self, payload: dict[str, Any]) -> NormalizedCall | None:
        # TODO: map SquadStack's webhook shape -> NormalizedCall
        return None

    async def create_bulk_calls(
        self,
        *,
        agent_id: str,
        recipients: list[dict[str, Any]],
        request_id: str,
        callback_base_url: str | None = None,
    ) -> dict[str, Any]:
        # TODO
        raise NotImplementedError("SquadStack bulk calls not implemented yet")
