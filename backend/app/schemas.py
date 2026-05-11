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


class ConnectedBreakdown(BaseModel):
    """The 474 Connected calls partitioned by interest_level (mutually
    exclusive — sums to connected_calls). Drives the stacked bar chart."""
    high: int = 0
    medium: int = 0
    low: int = 0
    not_covered: int = 0
    not_available: int = 0
    unclassified: int = 0


class UnreachedBreakdown(BaseModel):
    """Lead-attempts we did NOT connect with — includes the 436 in-progress
    bucket that's currently invisible on the dashboard. Sum equals
    row_count - connected_calls."""
    in_progress: int = 0
    not_connected: int = 0
    voicemail: int = 0
    failed: int = 0


class DuplicateCampaign(BaseModel):
    """One campaign's footprint inside the cross-campaign duplicate set.
    `shared_leads` = number of duplicate phones that appear in this campaign."""
    campaign_id: str
    campaign_name: str
    started_at: str | None = None
    shared_leads: int = 0


class OverviewMetrics(BaseModel):
    total_calls: int
    # row_count = lead-attempts in slice (one row per campaign × phone). Used
    # internally as the rate denominator and exposed for transparency.
    row_count: int = 0
    connected_calls: int
    failed_calls: int
    avg_duration_seconds: float
    engaged_calls: int
    interested_calls: int
    follow_up_calls: int
    # Hot leads = connected AND (interested OR follow-up). Kept for backward
    # compat with old funnel consumers; new UI uses Interested + Callback
    # as separate signals plus a Top-priority intersection.
    hot_lead_calls: int = 0
    connection_rate: float
    engagement_rate: float
    interest_rate: float
    follow_up_rate: float
    hot_lead_rate: float = 0.0
    conversion_rate: float
    # Lead-level metrics — additive, do not change call-based rates above.
    # The new funnel runs entirely on these.
    unique_leads: int = 0
    unique_connected_leads: int = 0
    unique_engaged_leads: int = 0
    unique_interested_leads: int = 0
    unique_callback_leads: int = 0
    unique_top_priority_leads: int = 0       # Interested AND Callback
    unique_callback_only_leads: int = 0      # Callback NOT also Interested
    # Mutually-exclusive sales-action buckets — every connected lead is in
    # exactly one. Sum (~) connected_calls.
    unique_interested_only_leads: int = 0    # Interested NOT Callback
    unique_no_intent_leads: int = 0          # Connected, no positive signal
    attempts_per_lead: float = 0.0
    lead_conversion_rate: float = 0.0
    # Visual breakdowns — populate the charts below the funnel.
    connected_breakdown: ConnectedBreakdown = ConnectedBreakdown()
    unreached_breakdown: UnreachedBreakdown = UnreachedBreakdown()
    unreached_total: int = 0
    # Cross-campaign duplicate leads — surfaces accidental re-uploads where
    # the same phone got dialed in two campaigns. 0 when the user filters
    # to a single campaign. Drives the "Duplicates" card.
    duplicate_leads: int = 0
    duplicate_rows: int = 0
    duplicate_dial_attempts: int = 0
    duplicate_campaigns: list[DuplicateCampaign] = []


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
    callback_calls: int = 0
    avg_duration_seconds: float
    connection_rate: float
    engagement_rate: float
    interest_rate: float
    callback_rate: float = 0.0


class DowBucket(BaseModel):
    dow: int                 # 1=Mon ... 7=Sun (ISODOW)
    dow_name: str            # "Mon", "Tue", ...
    total_calls: int
    connected_calls: int
    engaged_calls: int
    interested_calls: int
    callback_calls: int = 0
    avg_duration_seconds: float
    connection_rate: float
    engagement_rate: float
    interest_rate: float
    callback_rate: float = 0.0


class HeatmapCell(BaseModel):
    dow: int
    dow_name: str
    hour: int
    total_calls: int
    connected_calls: int
    engaged_calls: int
    interested_calls: int
    callback_calls: int = 0
    avg_duration_seconds: float
    connection_rate: float
    engagement_rate: float
    interest_rate: float
    callback_rate: float = 0.0


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
    """One stage of the conversion funnel.

    `key` is a stable identifier for filter/drill-down ('connected', 'engaged',
    'hotleads'). `stage` is the human label. `definition` explains what's
    counted — surfaced as a tooltip in the UI so users don't have to guess.
    `rate_of_previous` is the drop-off vs. the stage above (None for the top
    stage); `rate_of_top` is the cumulative survival rate from the top.
    """
    key: str
    stage: str
    count: int
    definition: str
    rate_of_previous: float | None = None
    rate_of_top: float = 0.0


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
    display_name: str | None = None   # User-set name from Hunar UI; falls back to "Campaign <id-prefix>"
    vendor_id: str
    vendor_name: str | None = None
    started_at: str | None
    unique_leads: int = 0             # Distinct phones in this campaign — denominator for connection_rate
    total_calls: int                  # Total dial attempts (includes retries)
    connected_calls: int
    engaged_calls: int = 0
    interested_calls: int
    connection_rate: float            # connected_calls / unique_leads
    engagement_rate: float = 0.0      # engaged_calls / connected_calls
    interest_rate: float              # interested_calls / connected_calls


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


# ---------------------------------------------------------------------------
# DoD Leads — Day-over-Day breakdown of leads with sales-action buckets
# ---------------------------------------------------------------------------
class DodLeadCampaign(BaseModel):
    """One campaign's contribution to a single day's lead total. All counts
    are unique-phone counts within the campaign — same definitions used by
    the Sales action breakdown row on Overview."""
    campaign_id: str
    campaign_name: str
    total_leads: int
    top_priority: int        # connected AND interested AND callback
    interested_only: int     # connected AND interested AND NOT callback
    callback_only: int       # connected AND callback AND NOT interested
    no_intent: int           # connected, neither signal
    unreached: int           # NOT connected (in-progress + failed + voicemail)


class DodLeadDay(BaseModel):
    """One upload day (IST calendar) with embedded campaign breakdown.

    Counts at this level are unique phones within the day. When a phone
    appears in multiple same-day campaigns, sum(campaigns) > day total —
    expected, surface in the UI if needed."""
    date: str                # ISO calendar date in IST, e.g. "2026-05-05"
    total_leads: int
    top_priority: int
    interested_only: int
    callback_only: int
    no_intent: int
    unreached: int
    campaigns: list[DodLeadCampaign] = []


class DodLeadsResponse(BaseModel):
    days: list[DodLeadDay]
    total_days: int


# ---------------------------------------------------------------------------
# Lookup tool — BDA phone-number search. Vendor identifiers deliberately
# absent from the public response shape.
# ---------------------------------------------------------------------------

class LookupCall(BaseModel):
    id: UUID  # opaque to BDA — only used by the recording-proxy endpoint
    when: datetime | None
    status: str
    answered_by: str
    duration_seconds: float
    retry_count: int
    has_recording: bool
    interest: str | None = None
    objection_text: str | None = None
    next_step: str | None = None
    follow_up_at: str | None = None
    language: str | None = None
    summary: str | None = None  # 1-2 sentence plain-English summary of this call


class LookupSummary(BaseModel):
    callee_name: str | None
    total_calls: int
    total_attempts: int          # SUM(retry_count + 1) across rows
    connected_count: int
    longest_duration_seconds: float
    latest_interest: str | None
    latest_objection: str | None
    latest_follow_up: str | None
    first_call_at: datetime | None
    last_call_at: datetime | None
    narrative: str | None = None  # plain-English overall summary across all calls


class LookupResult(BaseModel):
    normalized_phone: str | None  # null if input failed normalization
    input_phone: str
    found: bool
    summary: LookupSummary | None
    calls: list[LookupCall]
