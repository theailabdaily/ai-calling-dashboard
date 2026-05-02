"""Pydantic response models — the public API contract."""
from __future__ import annotations

from datetime import datetime
from typing import Any
from uuid import UUID

from pydantic import BaseModel


class VendorOut(BaseModel):
    id: UUID
    slug: str
    name: str
    is_active: bool

    class Config:
        from_attributes = True


class CampaignOut(BaseModel):
    id: UUID
    name: str
    display_name: str | None = None   # "{date} — {vendor} — {name}"
    vendor_id: UUID
    vendor_name: str | None = None
    vendor_request_id: str
    agent_id: UUID | None
    started_at: datetime | None
    expected_calls: int | None

    class Config:
        from_attributes = True


class AgentOut(BaseModel):
    id: UUID
    vendor_id: UUID
    vendor_agent_id: str
    name: str
    language: str | None
    voice_persona: str | None
    result_schema: dict[str, Any]

    class Config:
        from_attributes = True


class OverviewMetrics(BaseModel):
    total_calls: int
    connected_calls: int
    failed_calls: int
    avg_duration_seconds: float
    engaged_calls: int
    interested_calls: int
    follow_up_calls: int
    connection_rate: float
    engagement_rate: float
    interest_rate: float
    follow_up_rate: float
    conversion_rate: float
    # Lead-level metrics — additive, do not change call-based rates above
    unique_leads: int = 0
    unique_connected_leads: int = 0
    unique_interested_leads: int = 0
    attempts_per_lead: float = 0.0
    lead_conversion_rate: float = 0.0


class TimeBucket(BaseModel):
    bucket: str | None
    total: int
    connected: int
    interested: int


class HourBucket(BaseModel):
    hour: int
    total_calls: int
    connected_calls: int
    engaged_calls: int
    interested_calls: int
    avg_duration_seconds: float
    connection_rate: float
    engagement_rate: float
    interest_rate: float


class DowBucket(BaseModel):
    dow: int                 # 1=Mon ... 7=Sun (ISODOW)
    dow_name: str            # "Mon", "Tue", ...
    total_calls: int
    connected_calls: int
    engaged_calls: int
    interested_calls: int
    avg_duration_seconds: float
    connection_rate: float
    engagement_rate: float
    interest_rate: float


class HeatmapCell(BaseModel):
    dow: int
    dow_name: str
    hour: int
    total_calls: int
    connected_calls: int
    engaged_calls: int
    interested_calls: int
    avg_duration_seconds: float
    connection_rate: float
    engagement_rate: float
    interest_rate: float


class VendorHourSplit(BaseModel):
    vendor_id: str
    vendor_name: str
    hours: list[HourBucket]


class CampaignHourSplit(BaseModel):
    campaign_id: str
    campaign_name: str
    display_name: str | None = None
    hours: list[HourBucket]


class HourlyInsights(BaseModel):
    hour_breakdown: list[HourBucket]
    dow_breakdown:  list[DowBucket]
    heatmap:        list[HeatmapCell]
    by_vendor:      list[VendorHourSplit]
    by_campaign:    list[CampaignHourSplit]


class FunnelStage(BaseModel):
    stage: str
    count: int


class VendorRow(BaseModel):
    vendor_id: str
    vendor_slug: str
    vendor_name: str
    total_calls: int
    connected_calls: int
    avg_duration_seconds: float
    connection_rate: float
    engagement_rate: float
    interest_rate: float
    follow_up_rate: float
    # Lead-level — additive
    unique_leads: int = 0
    attempts_per_lead: float = 0.0


class CampaignRow(BaseModel):
    campaign_id: str
    campaign_name: str
    display_name: str | None = None   # "{date} — {vendor} — {name}"
    vendor_id: str
    vendor_name: str | None = None
    started_at: str | None
    total_calls: int
    connected_calls: int
    interested_calls: int
    connection_rate: float
    interest_rate: float


class CallListItem(BaseModel):
    id: UUID
    vendor_name: str
    campaign_name: str | None
    agent_name: str | None
    callee_name: str | None
    mobile_number: str | None
    status: str
    lifecycle_status: str
    answered_by: str
    engagement_status: str
    duration_seconds: float | None
    started_at: datetime | None
    has_recording: bool
    interested: str | None       # surfaced from result JSONB for the list
    follow_up_at: str | None


class CallListPage(BaseModel):
    items: list[CallListItem]
    total: int
    page: int
    page_size: int


class CallDetail(BaseModel):
    id: UUID
    vendor_id: UUID
    vendor_name: str
    vendor_call_id: str
    campaign_id: UUID | None
    campaign_name: str | None
    agent_id: UUID | None
    agent_name: str | None

    callee_name: str | None
    mobile_number: str | None
    from_phone_number: str | None
    language: str | None

    status: str
    lifecycle_status: str
    engagement_status: str
    answered_by: str
    call_ended_by: str

    duration_seconds: float | None
    duration_minutes: float | None
    user_speech_duration: float | None

    max_retries: int
    retry_count: int
    retries_left: int

    recording_url: str | None
    custom_data: dict[str, Any]
    result: dict[str, Any]

    started_at: datetime | None
    ended_at: datetime | None


class AgentPerformanceRow(BaseModel):
    agent_id: str
    agent_name: str
    vendor_name: str
    language: str | None
    voice_persona: str | None
    total_calls: int
    connected_calls: int
    avg_duration_seconds: float
    connection_rate: float
    engagement_rate: float
    interest_rate: float
    follow_up_rate: float


class TriggerCampaignRequest(BaseModel):
    vendor_slug: str
    vendor_agent_id: str         # the vendor's agent ID (from /api/agents)
    sheet_id: str
    worksheet_name: str | None = None
    campaign_name: str | None = None
    max_recipients: int | None = None    # safety cap


class TriggerCampaignResponse(BaseModel):
    status: str
    request_id: str
    sheet_rows_inserted: int
    recipients_pushed: int
    vendor_response: dict[str, Any] | None = None
    warning: str | None = None


class PushRecipient(BaseModel):
    callee_name: str
    mobile_number: str
    custom_data: dict[str, str] | None = None


class PushRecipientsRequest(BaseModel):
    vendor_slug: str
    vendor_agent_id: str
    campaign_name: str | None = None
    recipients: list[PushRecipient]


class OutcomeRow(BaseModel):
    outcome: str
    count: int
    pct: float


class OutcomeDistribution(BaseModel):
    by_call: list[OutcomeRow]
    by_lead: list[OutcomeRow]


class AttemptsRow(BaseModel):
    attempts: int        # total dial attempts on the lead (retry_count + 1, summed across their rows)
    leads: int           # unique leads that received exactly this many attempts
    connected: int       # of those leads, how many ever picked up (HUMAN + COMPLETED)
    pct_of_leads: float  # leads / total_leads (share of cohort by size)
    connect_rate: float  # connected / leads (cohort pickup rate)


class AttemptsDistribution(BaseModel):
    rows: list[AttemptsRow]
    total_leads: int
    total_connected: int
    total_calls: int


# ---------------------------------------------------------------------------
# Ledger / activity log — manual journal of "what we did" (gave leads, made
# campaign, changed prompt). Each entry can optionally link to a campaign;
# when it does, the GET endpoint joins live call_logs stats so the user can
# compare what they sent (leads_total) to what vendor actually dialed.
# ---------------------------------------------------------------------------

LEDGER_ENTRY_TYPES = ("leads_given", "campaign_created", "note", "config_change")


class LedgerLiveStats(BaseModel):
    """Live join from call_logs for the linked campaign — what really happened."""
    total_calls: int
    unique_leads: int
    connected: int
    interested: int
    avg_duration_seconds: float


class LedgerEntryIn(BaseModel):
    entry_type: str  # validated against LEDGER_ENTRY_TYPES in the route
    title: str
    occurred_at: datetime | None = None  # defaults to now() server-side
    vendor_id: UUID | None = None
    campaign_id: UUID | None = None
    leads_total: int | None = None
    leads_unique: int | None = None
    notes: str | None = None
    metadata: dict[str, Any] = {}


class LedgerEntryUpdate(BaseModel):
    """All-optional partial update."""
    entry_type: str | None = None
    title: str | None = None
    occurred_at: datetime | None = None
    vendor_id: UUID | None = None
    campaign_id: UUID | None = None
    leads_total: int | None = None
    leads_unique: int | None = None
    notes: str | None = None
    metadata: dict[str, Any] | None = None


class LedgerEntryOut(BaseModel):
    id: UUID
    entry_type: str
    title: str
    occurred_at: datetime

    # Denormalized for display — saves the frontend a separate vendors/campaigns lookup
    vendor_id: UUID | None
    vendor_name: str | None = None
    campaign_id: UUID | None
    campaign_name: str | None = None
    campaign_vendor_request_id: str | None = None

    leads_total: int | None
    leads_unique: int | None
    notes: str | None
    metadata: dict[str, Any] = {}

    # Populated when campaign_id is set; null otherwise
    live_stats: LedgerLiveStats | None = None

    created_at: datetime
    updated_at: datetime


class LedgerListResponse(BaseModel):
    items: list[LedgerEntryOut]
    total: int
    page: int
    page_size: int


class PendingCampaign(BaseModel):
    """A campaign that has no ledger entry attached yet — operational debt the
    Activity Log surfaces so every campaign ends up with a journal note."""
    campaign_id: UUID
    campaign_name: str
    vendor_id: UUID
    vendor_name: str
    vendor_request_id: str
    started_at: datetime | None = None
    expected_calls: int | None = None
    # Live counts so the user can see "this campaign already dialed 487 unique
    # leads — go log it" right in the banner without a second fetch.
    total_calls: int = 0
    unique_leads: int = 0


class PendingCampaignsResponse(BaseModel):
    items: list[PendingCampaign]
    total: int
    days: int  # window the backend used (echoed back for clarity)
