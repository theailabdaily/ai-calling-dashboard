"""
Vendor adapter abstraction.

Every AI-calling vendor (Hunar, SquadStack, future ones) implements this
interface. The rest of the application talks ONLY to this interface, never
to vendor-specific code. That is the contract that makes "add a new vendor"
a 1-day job.

Adapter responsibilities:
  1. Talk to the vendor's API (auth, pagination, retries).
  2. Normalize vendor responses into our canonical NormalizedCall / NormalizedAgent
     shape so downstream code doesn't care which vendor produced the data.
  3. Surface webhook payloads in normalized shape too.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any


# ---------------------------------------------------------------------------
# Normalized data shapes — vendor-agnostic.
# Adapters convert vendor responses INTO these.
# ---------------------------------------------------------------------------
@dataclass
class NormalizedAgent:
    vendor_agent_id: str
    name: str
    language: str | None = None
    voice_persona: str | None = None
    result_schema: dict[str, Any] = field(default_factory=dict)
    raw_payload: dict[str, Any] = field(default_factory=dict)


@dataclass
class NormalizedCall:
    vendor_call_id: str
    vendor_request_id: str | None              # maps to our campaign
    vendor_agent_id: str | None

    callee_name: str | None
    mobile_number: str | None
    from_phone_number: str | None
    language: str | None

    status: str                                # see CALL_STATUS_VALUES
    lifecycle_status: str
    engagement_status: str                     # ENGAGED / NOT_ENGAGED / UNKNOWN
    answered_by: str                           # HUMAN / MACHINE / UNKNOWN
    call_ended_by: str                         # AGENT / USER / UNKNOWN

    duration_seconds: float | None
    duration_minutes: float | None
    user_speech_duration: float | None

    max_retries: int
    retry_count: int
    retries_left: int

    recording_url: str | None

    custom_data: dict[str, Any]
    result: dict[str, Any]
    raw_payload: dict[str, Any]

    started_at: datetime | None
    ended_at: datetime | None
    vendor_created_at: datetime | None


# ---------------------------------------------------------------------------
# Adapter interface
# ---------------------------------------------------------------------------
class VendorAdapter(ABC):
    """All vendor adapters must implement this."""

    slug: str = ""        # 'hunar', 'squadstack' — overridden by subclasses
    display_name: str = ""

    @abstractmethod
    async def list_agents(self) -> list[NormalizedAgent]:
        """Fetch all agents/scripts/bots configured at the vendor."""

    @abstractmethod
    async def iter_calls(
        self,
        *,
        since: datetime | None = None,
        page_size: int = 200,
    ) -> AsyncIterator[NormalizedCall]:
        """
        Stream calls from the vendor, newest first.
        If `since` is provided, stop once we encounter calls older than it
        (incremental sync). Implementations should yield until exhausted or
        the caller breaks.
        """

    @abstractmethod
    async def get_call(self, vendor_call_id: str) -> NormalizedCall | None:
        """Fetch a single call by its vendor ID. Used by webhook handler."""

    @abstractmethod
    def parse_webhook(self, payload: dict[str, Any]) -> NormalizedCall | None:
        """
        Parse a webhook payload into a NormalizedCall. Return None if the
        payload is not a call-related event (e.g. just a recording_done
        event with no usable data on its own).
        """

    @abstractmethod
    async def create_bulk_calls(
        self,
        *,
        agent_id: str,
        recipients: list[dict[str, Any]],
        request_id: str,
        callback_base_url: str | None = None,
    ) -> dict[str, Any]:
        """
        Trigger a batch of calls. Used when we push leads from Google Sheets
        into the vendor. Returns vendor's response so we can store campaign metadata.
        """
