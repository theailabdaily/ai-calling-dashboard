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
