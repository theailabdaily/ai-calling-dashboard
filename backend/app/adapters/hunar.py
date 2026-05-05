"""
Hunar adapter.

API docs: https://api.voice.hunar.ai/docs/external/

Key facts that shaped this implementation:
  - Hunar has Agents and Calls. NO server-side concept of campaigns.
    What their UI calls "campaign" = bulk_call request, identified by request_id.
  - GET /calls/ has NO date filter. Only agent_id + status + page.
    For incremental sync we paginate newest-first and stop at calls we already have.
  - The `result` object on each call is dynamic, shaped by agent.result_schema.
  - Hunar fires `call_summary` webhook on terminal lifecycle — that's our
    primary real-time path. Polling is the safety net.
"""
from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from datetime import datetime
from typing import Any

import httpx
from dateutil.parser import isoparse

from app.adapters.base import NormalizedAgent, NormalizedCall, VendorAdapter

logger = logging.getLogger(__name__)


# Vendor → normalized status map. Hunar uses the same names as our enum,
# but we keep an explicit map so changes on their side don't silently break us.
HUNAR_STATUS_MAP = {
    "NOT_STARTED": "NOT_STARTED",
    "SCHEDULED": "SCHEDULED",
    "INITIATED": "INITIATED",
    "RINGING": "RINGING",
    "IN_PROGRESS": "IN_PROGRESS",
    "COMPLETED": "COMPLETED",
    "NOT_CONNECTED": "NOT_CONNECTED",
    "CANCELLED": "CANCELLED",
    "FAILED": "FAILED",
}


def _norm_status(value: str | None) -> str:
    if not value:
        return "UNKNOWN"
    return HUNAR_STATUS_MAP.get(value.upper(), "UNKNOWN")


def _norm_enum(value: str | None, allowed: tuple[str, ...]) -> str:
    if value and value.upper() in allowed:
        return value.upper()
    return "UNKNOWN"


def _parse_dt(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return isoparse(value)
    except (ValueError, TypeError):
        return None


class HunarAdapter(VendorAdapter):
    slug = "hunar"
    display_name = "Hunar"

    def __init__(self, api_key: str, base_url: str = "https://api.voice.hunar.ai/external/v1") -> None:
        if not api_key:
            raise ValueError("HUNAR_API_KEY is required")
        self.base_url = base_url.rstrip("/")
        self._headers = {"X-API-Key": api_key, "Content-Type": "application/json"}

    # -----------------------------------------------------------------
    # HTTP helper
    # -----------------------------------------------------------------
    async def _get(self, path: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        url = f"{self.base_url}{path}"
        # Hunar's /calls/ endpoint can take several minutes to respond when
        # scanning large datasets — observed 7 min in the wild for page 2.
        # Connect/write timeouts stay tight so we fail fast if Hunar is down,
        # but read timeout is generous enough for a slow scan to complete.
        timeout = httpx.Timeout(connect=10.0, read=600.0, write=10.0, pool=10.0)
        async with httpx.AsyncClient(timeout=timeout) as client:
            r = await client.get(url, headers=self._headers, params=params)
            r.raise_for_status()
            return r.json()

    async def _post(self, path: str, body: dict[str, Any]) -> dict[str, Any]:
        url = f"{self.base_url}{path}"
        timeout = httpx.Timeout(connect=10.0, read=120.0, write=10.0, pool=10.0)
        async with httpx.AsyncClient(timeout=timeout) as client:
            r = await client.post(url, headers=self._headers, json=body)
            r.raise_for_status()
            return r.json()

    # -----------------------------------------------------------------
    # Agents
    # -----------------------------------------------------------------
    async def list_agents(self) -> list[NormalizedAgent]:
        agents: list[NormalizedAgent] = []
        page = 1
        while True:
            data = await self._get("/agents/", params={"page": page, "page_size": 50})
            for a in data.get("results", []):
                agents.append(self._normalize_agent(a))
            if not data.get("next"):
                break
            page += 1
        return agents

    @staticmethod
    def _normalize_agent(raw: dict[str, Any]) -> NormalizedAgent:
        return NormalizedAgent(
            vendor_agent_id=raw["id"],
            name=raw.get("name", ""),
            language=raw.get("language"),
            voice_persona=raw.get("voice_persona"),
            result_schema=raw.get("result_schema") or {},
            raw_payload=raw,
        )

    # -----------------------------------------------------------------
    # Calls
    # -----------------------------------------------------------------
    async def iter_calls(
        self,
        *,
        since: datetime | None = None,
        page_size: int = 50,
    ) -> AsyncIterator[NormalizedCall]:
        # Smaller pages observed to be MUCH faster than page_size=200 in
        # practice — Hunar's /calls/ scan time appears to grow non-linearly
        # with batch size. 50 records typically returns in seconds; 200 has
        # been observed to take 7+ minutes during peak load. More HTTP
        # round-trips, but each one bounded.
        page = 1
        while True:
            data = await self._get("/calls/", params={"page": page, "page_size": page_size})
            results = data.get("results") or []
            if not results:
                break

            for raw in results:
                normalized = self._normalize_call(raw)
                # Hunar returns newest first; if we hit older-than-since, stop.
                if since and normalized.vendor_created_at and normalized.vendor_created_at < since:
                    return
                yield normalized

            if not data.get("next"):
                break
            page += 1

    async def get_call(self, vendor_call_id: str) -> NormalizedCall | None:
        try:
            raw = await self._get(f"/calls/{vendor_call_id}/")
        except httpx.HTTPStatusError as e:
            if e.response.status_code == 404:
                return None
            raise
        return self._normalize_call(raw)

    @staticmethod
    def _normalize_call(raw: dict[str, Any]) -> NormalizedCall:
        return NormalizedCall(
            vendor_call_id=raw["id"],
            vendor_request_id=raw.get("request_id"),
            vendor_agent_id=raw.get("agent_id"),
            callee_name=raw.get("callee_name"),
            mobile_number=raw.get("mobile_number"),
            from_phone_number=raw.get("from_phone_number"),
            language=raw.get("language"),
            status=_norm_status(raw.get("status")),
            lifecycle_status=_norm_status(raw.get("lifecycle_status")),
            engagement_status=_norm_enum(raw.get("engagement_status"), ("ENGAGED", "NOT_ENGAGED")),
            answered_by=_norm_enum(raw.get("answered_by"), ("HUMAN", "MACHINE")),
            call_ended_by=_norm_enum(raw.get("call_ended_by"), ("AGENT", "USER")),
            duration_seconds=raw.get("duration_seconds"),
            duration_minutes=raw.get("duration_minutes"),
            user_speech_duration=raw.get("user_speech_duration"),
            max_retries=int(raw.get("max_retries") or 0),
            retry_count=int(raw.get("retry_count") or 0),
            retries_left=int(raw.get("retries_left") or 0),
            recording_url=raw.get("recording_url"),
            custom_data=raw.get("custom_data") or {},
            result=raw.get("result") or {},
            raw_payload=raw,
            started_at=_parse_dt(raw.get("started_at")),
            ended_at=_parse_dt(raw.get("ended_at")),
            vendor_created_at=_parse_dt(raw.get("created_at")),
        )

    # -----------------------------------------------------------------
    # Webhooks
    # -----------------------------------------------------------------
    def parse_webhook(self, payload: dict[str, Any]) -> NormalizedCall | None:
        """
        Hunar fires several webhook event types. The richest is `call_summary`
        which bundles status + recording + result. We treat call_summary and
        call_status_updated as "syncable"; the others (recording_done,
        result_done) just trigger a refresh via get_call().
        """
        event = payload.get("event_type")
        if event in ("call_summary", "call_status_updated"):
            # Map flat webhook shape into something close to the call resource.
            mapped = {
                "id": payload.get("call_id"),
                "request_id": payload.get("request_id"),
                "agent_id": payload.get("agent_id"),
                "mobile_number": payload.get("to_number"),
                "from_phone_number": payload.get("from_number"),
                "status": payload.get("status"),
                "lifecycle_status": payload.get("lifecycle_status"),
                "answered_by": payload.get("answered_by"),
                "duration_seconds": payload.get("duration_seconds"),
                "duration_minutes": payload.get("duration_minutes"),
                "max_retries": payload.get("max_retries"),
                "retry_count": payload.get("retry_count"),
                "retries_left": payload.get("retries_left"),
                "recording_url": payload.get("recording_url"),
                "result": payload.get("result"),
                "started_at": payload.get("started_at"),
                "ended_at": payload.get("ended_at"),
                "created_at": payload.get("created_at"),
            }
            return self._normalize_call(mapped)
        return None

    # -----------------------------------------------------------------
    # Triggering calls (Sheets → Hunar pipeline uses this)
    # -----------------------------------------------------------------
    async def create_bulk_calls(
        self,
        *,
        agent_id: str,
        recipients: list[dict[str, Any]],
        request_id: str,
        callback_base_url: str | None = None,
    ) -> dict[str, Any]:
        body: dict[str, Any] = {
            "agent_id": agent_id,
            "request_id": request_id,
            "data": [
                {
                    "callee_name": r["callee_name"],
                    "mobile_number": r["mobile_number"],
                    "custom_data": r.get("custom_data", {}),
                }
                for r in recipients
            ],
            "remove_invalid_rows": True,
            "remove_duplicate_phone_numbers": True,
        }
        if callback_base_url:
            body["callback_config"] = {
                "call_status_callback_url": f"{callback_base_url}/webhooks/hunar/status",
                "call_summary_callback_url": f"{callback_base_url}/webhooks/hunar/summary",
            }
        return await self._post("/calls/bulk/", body)
