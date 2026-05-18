"""SQLAlchemy models — mirror /db/schema.sql exactly."""
from __future__ import annotations
from datetime import datetime
from typing import Any
import uuid

from sqlalchemy import (
    Boolean, DateTime, ForeignKey, Integer, Numeric, String, Text, UniqueConstraint, Index, func
)
from sqlalchemy.dialects.postgresql import JSONB, UUID, ENUM as PgEnum
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


# Enums (match the Postgres types)
CALL_STATUS_VALUES = (
    "NOT_STARTED", "SCHEDULED", "INITIATED", "RINGING", "IN_PROGRESS",
    "COMPLETED", "NOT_CONNECTED", "CANCELLED", "FAILED", "UNKNOWN",
)
ENGAGEMENT_VALUES = ("ENGAGED", "NOT_ENGAGED", "UNKNOWN")
ANSWERED_BY_VALUES = ("HUMAN", "MACHINE", "UNKNOWN")
ENDED_BY_VALUES = ("AGENT", "USER", "UNKNOWN")
LEAD_SOURCE_VALUES = ("google_sheets", "api", "manual", "csv_upload")
CAMPAIGN_SOURCE_VALUES = ("vendor_ui", "sheets_import", "api", "manual")
SYNC_STATUS_VALUES = ("running", "success", "partial", "failed")
SYNC_JOB_VALUES = ("agents", "calls", "campaigns", "sheets_leads")


CallStatusEnum = PgEnum(*CALL_STATUS_VALUES, name="call_status", create_type=False)
EngagementEnum = PgEnum(*ENGAGEMENT_VALUES, name="engagement_status", create_type=False)
AnsweredByEnum = PgEnum(*ANSWERED_BY_VALUES, name="answered_by", create_type=False)
EndedByEnum = PgEnum(*ENDED_BY_VALUES, name="call_ended_by", create_type=False)
LeadSourceEnum = PgEnum(*LEAD_SOURCE_VALUES, name="lead_source", create_type=False)
CampaignSourceEnum = PgEnum(*CAMPAIGN_SOURCE_VALUES, name="campaign_source", create_type=False)
SyncStatusEnum = PgEnum(*SYNC_STATUS_VALUES, name="sync_status", create_type=False)
SyncJobEnum = PgEnum(*SYNC_JOB_VALUES, name="sync_job", create_type=False)


class Vendor(Base):
    __tablename__ = "vendors"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, server_default=func.uuid_generate_v4())
    slug: Mapped[str] = mapped_column(String, unique=True, nullable=False)
    name: Mapped[str] = mapped_column(String, nullable=False)
    api_base_url: Mapped[str] = mapped_column(String, nullable=False)
    config: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict, nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class Agent(Base):
    __tablename__ = "agents"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, server_default=func.uuid_generate_v4())
    vendor_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("vendors.id", ondelete="CASCADE"), nullable=False)
    vendor_agent_id: Mapped[str] = mapped_column(String, nullable=False)
    name: Mapped[str] = mapped_column(String, nullable=False)
    language: Mapped[str | None] = mapped_column(String)
    voice_persona: Mapped[str | None] = mapped_column(String)
    result_schema: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict, nullable=False)
    raw_payload: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    product_line_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("product_lines.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    __table_args__ = (UniqueConstraint("vendor_id", "vendor_agent_id"),)


class ProductLine(Base):
    __tablename__ = "product_lines"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, server_default=func.gen_random_uuid())
    slug: Mapped[str] = mapped_column(String, nullable=False, unique=True)
    name: Mapped[str] = mapped_column(String, nullable=False)
    description: Mapped[str | None] = mapped_column(String)
    color: Mapped[str | None] = mapped_column(String)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class Campaign(Base):
    __tablename__ = "campaigns"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, server_default=func.uuid_generate_v4())
    vendor_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("vendors.id", ondelete="CASCADE"), nullable=False)
    vendor_request_id: Mapped[str] = mapped_column(String, nullable=False)
    vendor_campaign_id: Mapped[str | None] = mapped_column(String, nullable=True, index=True)
    name: Mapped[str] = mapped_column(String, nullable=False)
    display_name: Mapped[str | None] = mapped_column(String, nullable=True)
    agent_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("agents.id", ondelete="SET NULL"))
    source: Mapped[str] = mapped_column(CampaignSourceEnum, default="vendor_ui", nullable=False)
    metadata_: Mapped[dict[str, Any]] = mapped_column("metadata", JSONB, default=dict, nullable=False)
    expected_calls: Mapped[int | None] = mapped_column(Integer)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    __table_args__ = (UniqueConstraint("vendor_id", "vendor_request_id"),)


class Lead(Base):
    __tablename__ = "leads"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, server_default=func.uuid_generate_v4())
    source: Mapped[str] = mapped_column(LeadSourceEnum, nullable=False)
    source_ref: Mapped[str | None] = mapped_column(String)
    name: Mapped[str] = mapped_column(String, nullable=False)
    mobile_number: Mapped[str] = mapped_column(String, nullable=False)
    email: Mapped[str | None] = mapped_column(String)
    custom_data: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict, nullable=False)
    ingested_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class CallLog(Base):
    __tablename__ = "call_logs"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, server_default=func.uuid_generate_v4())
    vendor_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("vendors.id", ondelete="CASCADE"), nullable=False)
    vendor_call_id: Mapped[str] = mapped_column(String, nullable=False)
    campaign_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("campaigns.id", ondelete="SET NULL"))
    agent_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("agents.id", ondelete="SET NULL"))
    lead_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("leads.id", ondelete="SET NULL"))

    callee_name: Mapped[str | None] = mapped_column(String)
    mobile_number: Mapped[str | None] = mapped_column(String)
    from_phone_number: Mapped[str | None] = mapped_column(String)
    language: Mapped[str | None] = mapped_column(String)

    status: Mapped[str] = mapped_column(CallStatusEnum, default="UNKNOWN", nullable=False)
    lifecycle_status: Mapped[str] = mapped_column(CallStatusEnum, default="UNKNOWN", nullable=False)
    engagement_status: Mapped[str] = mapped_column(EngagementEnum, default="UNKNOWN", nullable=False)
    answered_by: Mapped[str] = mapped_column(AnsweredByEnum, default="UNKNOWN", nullable=False)
    call_ended_by: Mapped[str] = mapped_column(EndedByEnum, default="UNKNOWN", nullable=False)

    duration_seconds: Mapped[float | None] = mapped_column(Numeric(10, 2))
    duration_minutes: Mapped[float | None] = mapped_column(Numeric(10, 2))
    user_speech_duration: Mapped[float | None] = mapped_column(Numeric(10, 2))

    max_retries: Mapped[int] = mapped_column(Integer, default=0)
    retry_count: Mapped[int] = mapped_column(Integer, default=0)
    retries_left: Mapped[int] = mapped_column(Integer, default=0)

    recording_url: Mapped[str | None] = mapped_column(Text)

    custom_data: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict, nullable=False)
    result: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict, nullable=False)
    raw_payload: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)

    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    vendor_created_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    ingested_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    last_synced_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    __table_args__ = (
        UniqueConstraint("vendor_id", "vendor_call_id"),
        Index("idx_calls_vendor_started", "vendor_id", "started_at"),
    )


class SyncRun(Base):
    __tablename__ = "sync_runs"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, server_default=func.uuid_generate_v4())
    vendor_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("vendors.id", ondelete="CASCADE"))
    job_type: Mapped[str] = mapped_column(SyncJobEnum, nullable=False)
    status: Mapped[str] = mapped_column(SyncStatusEnum, default="running", nullable=False)
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    records_seen: Mapped[int] = mapped_column(Integer, default=0)
    records_upserted: Mapped[int] = mapped_column(Integer, default=0)
    high_water_mark: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    error_message: Mapped[str | None] = mapped_column(Text)
    metadata_: Mapped[dict[str, Any]] = mapped_column("metadata", JSONB, default=dict, nullable=False)


# ---------------------------------------------------------------------------
# Activity log / ledger — operational journal of "what we did" (gave leads
# to vendor, made campaign, changed prompt). Each entry can optionally link
# to a campaign; when it does, the GET endpoint joins live call_logs stats so
# the user can compare what they sent (leads_total) vs what vendor dialed.
# Table was created via migration; this is the SQLAlchemy mirror.
# ---------------------------------------------------------------------------
class LedgerEntry(Base):
    __tablename__ = "ledger_entries"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, server_default=func.uuid_generate_v4())
    entry_type: Mapped[str] = mapped_column(Text, nullable=False)
    title: Mapped[str] = mapped_column(Text, nullable=False)
    occurred_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)

    vendor_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("vendors.id", ondelete="SET NULL"))
    campaign_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("campaigns.id", ondelete="SET NULL"))

    leads_total: Mapped[int | None] = mapped_column(Integer)
    leads_unique: Mapped[int | None] = mapped_column(Integer)
    notes: Mapped[str | None] = mapped_column(Text)
    metadata_: Mapped[dict[str, Any]] = mapped_column("metadata", JSONB, default=dict, nullable=False)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False)


class AuthEvent(Base):
    """Audit log of authentication attempts. Written by NextAuth via the
    internal endpoint. Read by /admin/login-activity in the frontend."""
    __tablename__ = "auth_events"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, server_default=func.gen_random_uuid())
    email: Mapped[str] = mapped_column(Text, nullable=False)
    event: Mapped[str] = mapped_column(Text, nullable=False)
    # 'signin_success' | 'signin_blocked_non_testbook' | 'signout' | 'signin_error'
    ip: Mapped[str | None] = mapped_column(Text)
    user_agent: Mapped[str | None] = mapped_column(Text)
    occurred_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
