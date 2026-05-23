"""
Metrics computation.

All dashboard math lives here. Definitions are deliberate — when in doubt,
default to the most defensible (i.e. boring) interpretation.

DEFINITIONS:
  total_calls       = SUM(retry_count + 1) across rows in the window.
                      Each call_log row represents ONE lead; retry_count tells
                      us how many times Hunar redialed. So a row with
                      retry_count=4 contributed 5 dial attempts. SCHEDULED
                      rows that were never actually dialed (retry_count=0,
                      started_at NULL) count as 0.
                      This is what dialer-industry tools call "calls" and what
                      the dashboard tile claims to show.
  dialed_leads      = COUNT(*) — rows in slice. Used internally as the
                      denominator for lead-level rates, since our rate
                      numerators (connected, engaged, interested) come from
                      one row per lead. Not exposed separately; consumers
                      see `unique_leads` (distinct phones) which is usually
                      identical except across-campaign duplicates.
  connected_calls   = lifecycle_status='COMPLETED' AND answered_by='HUMAN'
                      Rationale: machine pickups are NOT a real connection.
                      One row = one lead, so this counts leads-connected.
  failed_calls      = status IN ('FAILED', 'NOT_CONNECTED', 'CANCELLED')
  connection_rate   = connected_calls / dialed_leads
                      Lead-level. We can't compute per-dial connection rate
                      because the schema doesn't track per-attempt outcomes —
                      retry_count tells us how many times we dialed, not which
                      attempt succeeded.
  avg_call_duration = AVG(duration_seconds) WHERE connected
  engagement_rate   = engaged_leads / connected_leads (already lead-level both ways)
  interest_rate     = interested_leads / connected_leads
                      ('interest_level' HIGH/MEDIUM is Hunar's convention)
  follow_up_rate    = follow_up_leads / connected_leads
  conversion_rate   = configurable per-deployment. v1 stub: same as interest_rate.
                      In production, you wire downstream lead status here.
  attempts_per_lead = total_calls / unique_leads (now genuinely reflects retries)
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any
from uuid import UUID

from sqlalchemy import and_, case, desc, distinct, func, literal, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import CallLog, Campaign, Vendor, Agent, ProductLine


@dataclass
class MetricFilters:
    start: datetime | None = None
    end: datetime | None = None
    vendor_ids: list[UUID] | None = None
    campaign_ids: list[UUID] | None = None
    agent_ids: list[UUID] | None = None
    product_line_slug: str | None = None  # filters via agents.product_line_id → product_lines.slug

    def apply(self, stmt):
        conds = []
        # Filter by call ACTIVITY date (when the call ended, or upload date for
        # never-dialed rows). See `_activity_at` definition below. This is what
        # the Leads page uses, so picking "Today" on the date range surfaces the
        # same leads on Overview / Call Logs / Funnel as on the Leads table.
        if self.start:
            conds.append(_activity_at >= self.start)
        if self.end:
            conds.append(_activity_at <= self.end)
        if self.vendor_ids:
            conds.append(CallLog.vendor_id.in_(self.vendor_ids))
        if self.campaign_ids:
            conds.append(CallLog.campaign_id.in_(self.campaign_ids))
        if self.agent_ids:
            conds.append(CallLog.agent_id.in_(self.agent_ids))
        if self.product_line_slug:
            # Resolve slug → agent_ids via a correlated subquery. Cheaper than
            # forcing every metric query to JOIN agents+product_lines.
            conds.append(
                CallLog.agent_id.in_(
                    select(Agent.id).join(ProductLine, ProductLine.id == Agent.product_line_id)
                    .where(ProductLine.slug == self.product_line_slug)
                )
            )
        if conds:
            stmt = stmt.where(and_(*conds))
        return stmt


# Reusable expressions

# Date semantics for ALL filtering and time-bucketing in this module.
#
# `vendor_created_at` is when Hunar created the row (queue/upload time). That
# was the original filter column but it gave a confusing result: a campaign
# launched on May 12 whose dialer runs every day across May 13, 14, 15 would
# put EVERY call into "May 12" because that's when the rows were created —
# even though the actual call activity (and the result, and the revenue, and
# the customer interaction) happened on later days.
#
# `_activity_at` instead is "when did the most recent call activity happen
# on this row", matching the Leads page's `final_at` definition. For a
# completed call: ended_at. For a still-pending/scheduled row that hasn't
# been dialed yet: vendor_created_at (fallback). This is what BD users mean
# when they say "today's leads" — the leads that something HAPPENED to
# today, not the leads that were uploaded today.
#
# Centralized here so every filter / time-bucket on Overview, Funnel, Calls
# Over Time, Hourly Insights, Vendor / Campaign / Agent breakdowns, Call
# Logs, and CSV exports stays aligned with the Leads page. Changing this
# single expression changes the meaning of "today" everywhere.
_activity_at = func.coalesce(CallLog.ended_at, CallLog.vendor_created_at)

_is_connected = and_(CallLog.lifecycle_status == "COMPLETED", CallLog.answered_by == "HUMAN")
_is_engaged = CallLog.engagement_status == "ENGAGED"
# JSONB key check — Hunar uses qualitative levels.
# interest_level: HIGH | MEDIUM | LOW | "Not Covered" | "NOT AVAILABLE"
# next_step_interest: CALLBACK | NONE | UNSURE | "Not Covered" | "NOT AVAILABLE"
_is_interested = func.upper(CallLog.result["interest_level"].astext).in_(["HIGH", "MEDIUM"])
_has_follow_up = func.upper(CallLog.result["next_step_interest"].astext) == "CALLBACK"
# Hot lead = either signal of buying intent. Drives the bottom funnel stage
# and the "Hot leads" tile.
#
# Why a UNION not an intersection: in Hunar's data these are independent
# signals — a lead can ask for a callback without being tagged HIGH/MEDIUM,
# or vice versa. Treating them as nested ("Interested" then "Follow-up")
# produced a broken funnel where Follow-up (66) > Interested (57), the funnel
# went UP, and users got confused. Either signal is sales-positive intent
# for an EdTech lead, so OR them.
# By inclusion-exclusion: |hot| = |interested| + |followup| - |both|.
_is_hot_lead = or_(_is_interested, _has_follow_up)

# Dial-attempts per row: retry_count + 1 (one initial dial + N retries),
# except a SCHEDULED row that was never dialed (no started_at) contributes 0.
# Using literal(1) keeps the SQL portable across SQLAlchemy versions.
_dial_attempts_per_row = case(
    (
        and_(
            CallLog.lifecycle_status == "SCHEDULED",
            CallLog.retry_count == 0,
            CallLog.started_at.is_(None),
        ),
        0,
    ),
    else_=CallLog.retry_count + literal(1),
)
# Sum of dial attempts across a slice — what we surface as "total_calls".
_total_dials_expr = func.coalesce(func.sum(_dial_attempts_per_row), 0)


def _safe_div(num: float | int | None, den: float | int | None) -> float:
    if not den:
        return 0.0
    return float(num or 0) / float(den)


# ---------------------------------------------------------------------------
# Top-level metrics block (the four big tiles on Overview page)
# ---------------------------------------------------------------------------
async def compute_overview_metrics(db: AsyncSession, filters: MetricFilters) -> dict[str, Any]:
    # unique_leads = count of distinct mobile numbers — one person dialed N times = 1 lead.
    # Empty/NULL numbers excluded so we don't undercount silently.
    _valid_phone = case(
        (and_(CallLog.mobile_number.isnot(None), CallLog.mobile_number != ""), CallLog.mobile_number)
    )
    # Per-row signal expressions that we'll wrap in COUNT(DISTINCT phone) FILTER.
    # Using FILTER inside DISTINCT means: "distinct phones where this signal is true on at least one row".
    # i.e. a lead counts as "engaged" if they engaged on any of their attempts.
    _conn_phone     = case((_is_connected, _valid_phone))
    _eng_phone      = case((and_(_is_connected, _is_engaged), _valid_phone))
    _intr_phone     = case((and_(_is_connected, _is_interested), _valid_phone))
    _cb_phone       = case((and_(_is_connected, _has_follow_up), _valid_phone))
    _topprio_phone  = case((and_(_is_connected, _is_interested, _has_follow_up), _valid_phone))
    # Mutually-exclusive sales-action buckets — sliced from Connected so each
    # connected lead lands in exactly one bucket. Sum equals connected_calls.
    # Drives the "Sales action breakdown" cards under the funnel.
    _intr_only_phone = case((and_(_is_connected, _is_interested,         ~_has_follow_up), _valid_phone))
    _cb_only_phone   = case((and_(_is_connected, ~_is_interested,         _has_follow_up), _valid_phone))
    _no_intent_phone = case((and_(_is_connected, ~_is_interested,        ~_has_follow_up), _valid_phone))

    # Connected breakdown by interest_level (mutually exclusive — uses the
    # row's interest_level, not "best across attempts". For the connected
    # row itself, this is fine — a connected phone has at most a few rows
    # and they're usually consistent. The sum across buckets equals
    # connected_calls (row count), which lets the stacked bar chart be honest.
    _il = func.upper(CallLog.result["interest_level"].astext)
    _conn_high          = and_(_is_connected, _il == "HIGH")
    _conn_medium        = and_(_is_connected, _il == "MEDIUM")
    _conn_low           = and_(_is_connected, _il == "LOW")
    _conn_not_covered   = and_(_is_connected, _il == "NOT COVERED")
    _conn_not_available = and_(_is_connected, _il == "NOT AVAILABLE")
    _conn_unclassified  = and_(
        _is_connected,
        or_(_il.is_(None), _il.notin_(["HIGH", "MEDIUM", "LOW", "NOT COVERED", "NOT AVAILABLE"])),
    )

    # Lifecycle breakdown — what happened to leads we *didn't* connect with.
    # The 436 IN_PROGRESS bucket is the one currently invisible on the dashboard.
    _is_in_progress  = CallLog.lifecycle_status == "IN_PROGRESS"
    _is_voicemail    = and_(CallLog.lifecycle_status == "NOT_CONNECTED", CallLog.answered_by == "MACHINE")
    _is_not_conn_nv  = and_(CallLog.lifecycle_status == "NOT_CONNECTED", CallLog.answered_by != "MACHINE")
    _is_failed       = CallLog.lifecycle_status == "FAILED"

    stmt = select(
        # row_count = leads-with-attempts in slice. Used as denominator for
        # rates because connected/engaged/interested counts come from one row
        # per lead. Not exposed publicly — exposed `unique_leads` is the
        # consumer-facing equivalent (distinct phones).
        func.count(CallLog.id).label("row_count"),
        # Public total_calls = total dial attempts (initial + retries).
        # This is what the "Dial attempts" tile claims to show in its tooltip.
        _total_dials_expr.label("total_calls"),
        func.count(distinct(_valid_phone)).label("unique_leads"),
        # Row-based counts — kept for backward compat (existing tiles use these)
        func.sum(case((_is_connected, 1), else_=0)).label("connected_calls"),
        func.sum(case((CallLog.status.in_(("FAILED", "NOT_CONNECTED", "CANCELLED")), 1), else_=0)).label("failed_calls"),
        func.avg(case((_is_connected, CallLog.duration_seconds))).label("avg_duration_sec"),
        func.sum(case((and_(_is_connected, _is_engaged), 1), else_=0)).label("engaged_calls"),
        func.sum(case((and_(_is_connected, _is_interested), 1), else_=0)).label("interested_calls"),
        func.sum(case((and_(_is_connected, _has_follow_up), 1), else_=0)).label("follow_up_calls"),
        func.sum(case((and_(_is_connected, _is_hot_lead), 1), else_=0)).label("hot_lead_calls"),
        # Unique-lead counts — these drive the new funnel
        func.count(distinct(_conn_phone)).label("unique_connected_leads"),
        func.count(distinct(_eng_phone)).label("unique_engaged_leads"),
        func.count(distinct(_intr_phone)).label("unique_interested_leads"),
        func.count(distinct(_cb_phone)).label("unique_callback_leads"),
        func.count(distinct(_topprio_phone)).label("unique_top_priority_leads"),
        func.count(distinct(_intr_only_phone)).label("unique_interested_only_leads"),
        func.count(distinct(_cb_only_phone)).label("unique_callback_only_leads_q"),
        func.count(distinct(_no_intent_phone)).label("unique_no_intent_leads"),
        # Connected breakdown — row counts per interest bucket (sum to connected_calls)
        func.sum(case((_conn_high, 1), else_=0)).label("conn_high"),
        func.sum(case((_conn_medium, 1), else_=0)).label("conn_medium"),
        func.sum(case((_conn_low, 1), else_=0)).label("conn_low"),
        func.sum(case((_conn_not_covered, 1), else_=0)).label("conn_not_covered"),
        func.sum(case((_conn_not_available, 1), else_=0)).label("conn_not_available"),
        func.sum(case((_conn_unclassified, 1), else_=0)).label("conn_unclassified"),
        # Unreached breakdown — what happened to the rest
        func.sum(case((_is_in_progress, 1), else_=0)).label("in_progress_rows"),
        func.sum(case((_is_voicemail, 1), else_=0)).label("voicemail_rows"),
        func.sum(case((_is_not_conn_nv, 1), else_=0)).label("not_connected_rows"),
        func.sum(case((_is_failed, 1), else_=0)).label("failed_rows"),
    )
    stmt = filters.apply(stmt)
    row = (await db.execute(stmt)).one()

    row_count = int(row.row_count or 0)
    total = int(row.total_calls or 0)
    unique_leads = int(row.unique_leads or 0)
    unique_connected = int(row.unique_connected_leads or 0)
    unique_engaged = int(row.unique_engaged_leads or 0)
    unique_interested = int(row.unique_interested_leads or 0)
    unique_callback = int(row.unique_callback_leads or 0)
    unique_top_priority = int(row.unique_top_priority_leads or 0)
    # The 4 mutually-exclusive sales-action buckets, all from SQL directly
    # (not inclusion-exclusion arithmetic). Each connected lead lands in
    # EXACTLY one. Sum equals unique_connected modulo 2 unclassified leads
    # whose interest_level is NULL — those fall into no_intent. So the four
    # buckets together strictly equal unique_connected.
    unique_interested_only = int(row.unique_interested_only_leads or 0)
    unique_callback_only   = int(row.unique_callback_only_leads_q or 0)
    unique_no_intent       = int(row.unique_no_intent_leads or 0)
    connected = int(row.connected_calls or 0)
    failed = int(row.failed_calls or 0)
    engaged = int(row.engaged_calls or 0)
    interested = int(row.interested_calls or 0)
    follow_up = int(row.follow_up_calls or 0)
    hot_leads = int(row.hot_lead_calls or 0)

    connected_breakdown = {
        "high":          int(row.conn_high or 0),
        "medium":        int(row.conn_medium or 0),
        "low":           int(row.conn_low or 0),
        "not_covered":   int(row.conn_not_covered or 0),
        "not_available": int(row.conn_not_available or 0),
        "unclassified":  int(row.conn_unclassified or 0),
    }
    in_progress_rows = int(row.in_progress_rows or 0)
    voicemail_rows = int(row.voicemail_rows or 0)
    not_connected_rows = int(row.not_connected_rows or 0)
    failed_rows = int(row.failed_rows or 0)
    unreached_breakdown = {
        "in_progress":   in_progress_rows,
        "not_connected": not_connected_rows,
        "voicemail":     voicemail_rows,
        "failed":        failed_rows,
    }
    # Total unreached row-count (helpful for tile)
    unreached_total = in_progress_rows + voicemail_rows + not_connected_rows + failed_rows

    # ---------------------------------------------------------------
    # Cross-campaign duplicate leads — same phone uploaded to multiple
    # campaigns. Done as a separate query because it requires GROUP BY
    # phone (different shape from the main aggregate). Cheap — same
    # filtered slice, indexed on (vendor_id, vendor_created_at).
    #
    # Why this matters operationally: each duplicate consumes a fresh
    # set of dials, sometimes intentional (re-targeting) and sometimes
    # accidental (the same lead list got uploaded to two campaigns).
    # We surface counts; we don't editorialize on "waste".
    #
    # CANCELLED rows are excluded BEFORE the group-by — if a lead's only
    # prior touch was a CANCELLED call (campaign paused, lead pulled
    # before dial, etc.), re-adding them to a new campaign is a legitimate
    # retry, not a duplicate. Including those was inflating the count by
    # ~40% (1,841 → 1,095 on a typical 30-day slice). We do NOT exclude
    # NOT_CONNECTED (lead was actually dialed, just didn't pick up) or
    # FAILED (rare; vendor error — case can be revisited if needed).
    # ---------------------------------------------------------------
    _phone_grouped = (
        select(
            CallLog.mobile_number.label("phone"),
            func.count(CallLog.id).label("rows"),
            func.count(distinct(CallLog.campaign_id)).label("campaigns"),
            _total_dials_expr.label("dials"),
        )
        .where(and_(
            CallLog.mobile_number.isnot(None),
            CallLog.mobile_number != "",
            CallLog.lifecycle_status != "CANCELLED",
        ))
        .group_by(CallLog.mobile_number)
    )
    _phone_grouped = filters.apply(_phone_grouped).subquery()

    dup_stmt = select(
        func.count().filter(_phone_grouped.c.campaigns > 1).label("dup_leads"),
        func.coalesce(func.sum(_phone_grouped.c.rows).filter(_phone_grouped.c.campaigns > 1), 0).label("dup_rows"),
        func.coalesce(func.sum(_phone_grouped.c.dials).filter(_phone_grouped.c.campaigns > 1), 0).label("dup_dials"),
    ).select_from(_phone_grouped)
    drow = (await db.execute(dup_stmt)).one()
    dup_leads = int(drow.dup_leads or 0)
    dup_rows = int(drow.dup_rows or 0)
    dup_dials = int(drow.dup_dials or 0)

    # Per-campaign breakdown of where the duplicate phones live —
    # only computed when there ARE duplicates (otherwise: noop).
    duplicate_campaigns: list[dict[str, Any]] = []
    if dup_leads > 0:
        # Subquery: phones that appear in 2+ campaigns within this slice
        from app.models import Campaign as _Cmp
        # Subquery: phones that appear in 2+ campaigns within this slice.
        # Same CANCELLED-exclusion as the main dup query above — needs to
        # stay in sync so this list matches the count card.
        dup_phones_sq = (
            select(CallLog.mobile_number)
            .where(and_(
                CallLog.mobile_number.isnot(None),
                CallLog.mobile_number != "",
                CallLog.lifecycle_status != "CANCELLED",
            ))
            .group_by(CallLog.mobile_number)
            .having(func.count(distinct(CallLog.campaign_id)) > 1)
        )
        dup_phones_sq = filters.apply(dup_phones_sq).subquery()

        camp_stmt = (
            select(
                _Cmp.id,
                _Cmp.name,
                _Cmp.display_name.label("display_name_db"),
                _Cmp.vendor_request_id,
                _Cmp.vendor_campaign_id,
                func.coalesce(_Cmp.started_at, _Cmp.created_at).label("started_at"),
                func.count().label("shared"),
            )
            .join(CallLog, CallLog.campaign_id == _Cmp.id)
            .where(and_(
                CallLog.mobile_number.in_(select(dup_phones_sq.c.mobile_number)),
                # Mirror the dup_phones_sq filter: only count non-cancelled
                # rows in each campaign's "shared leads" tally, so the
                # per-campaign breakdown matches the headline count card.
                CallLog.lifecycle_status != "CANCELLED",
            ))
            .group_by(_Cmp.id, _Cmp.name, _Cmp.display_name, _Cmp.vendor_request_id,
                      _Cmp.vendor_campaign_id, _Cmp.started_at, _Cmp.created_at)
            .order_by(func.count().desc())
        )
        camp_stmt = filters.apply(camp_stmt)
        for r in (await db.execute(camp_stmt)).all():
            if r.display_name_db:
                display = r.display_name_db
            elif r.vendor_campaign_id:
                display = f"Campaign {r.vendor_campaign_id[:8]}"
            else:
                display = f"Campaign {r.vendor_request_id[:8]}"
            duplicate_campaigns.append({
                "campaign_id":   str(r.id),
                "campaign_name": display,
                "started_at":    r.started_at.isoformat() if r.started_at else None,
                "shared_leads":  int(r.shared or 0),
            })

    return {
        "total_calls": total,                          # 3,810 — dial attempts
        "row_count": row_count,                        # 1,003 — rows in call_logs (= lead-attempts in slice)
        "unique_leads": unique_leads,                  # 929 — distinct phones
        "unique_connected_leads": unique_connected,
        "unique_engaged_leads": unique_engaged,
        "unique_interested_leads": unique_interested,
        "unique_callback_leads": unique_callback,
        "unique_top_priority_leads": unique_top_priority,
        "unique_callback_only_leads": unique_callback_only,
        "unique_interested_only_leads": unique_interested_only,
        "unique_no_intent_leads": unique_no_intent,
        "connected_calls": connected,
        "failed_calls": failed,
        "avg_duration_seconds": float(row.avg_duration_sec or 0),
        "engaged_calls": engaged,
        "interested_calls": interested,
        "follow_up_calls": follow_up,
        "hot_lead_calls": hot_leads,
        # Connected (474) further sliced by interest_level — drives the
        # "Connected breakdown" stacked bar. Sum equals connected_calls.
        "connected_breakdown": connected_breakdown,
        # The leads we DIDN'T connect with — including the previously-invisible
        # 436 in-progress bucket. Sum equals row_count - connected_calls.
        "unreached_breakdown": unreached_breakdown,
        "unreached_total": unreached_total,
        # Rate denominators are LEAD-level (row_count), not dial-level.
        # See module docstring for why per-dial rates aren't computable.
        "connection_rate": _safe_div(connected, row_count),
        "engagement_rate": _safe_div(engaged, connected),
        "interest_rate": _safe_div(interested, connected),
        "follow_up_rate": _safe_div(follow_up, connected),
        "hot_lead_rate": _safe_div(hot_leads, connected),
        "conversion_rate": _safe_div(interested, row_count),  # v1 proxy
        "lead_conversion_rate": _safe_div(unique_interested, unique_leads),
        # Now actually meaningful: (initial + retries) / leads.
        "attempts_per_lead": (total / unique_leads) if unique_leads else 0.0,
        # Cross-campaign duplicates — same phone uploaded to multiple campaigns.
        # 0 when filter narrows to a single campaign (can't have duplicates within one).
        "duplicate_leads": dup_leads,
        "duplicate_rows": dup_rows,
        "duplicate_dial_attempts": dup_dials,
        "duplicate_campaigns": duplicate_campaigns,
    }


# ---------------------------------------------------------------------------
# Calls over time — bucketed by day for the line chart
# ---------------------------------------------------------------------------
async def calls_over_time(db: AsyncSession, filters: MetricFilters, bucket: str = "day") -> list[dict[str, Any]]:
    # Bucket by activity date (call end, fallback to upload date). Matches the
    # Leads page so the chart counts agree with the Leads page totals.
    trunc = func.date_trunc(bucket, _activity_at)
    stmt = (
        select(
            trunc.label("bucket"),
            # total = dial attempts in bucket. NB: retries attribute to the
            # day the lead was originally created, since the schema only has
            # one timestamp per row. Approximation, not perfect.
            _total_dials_expr.label("total"),
            func.sum(case((_is_connected, 1), else_=0)).label("connected"),
            func.sum(case((and_(_is_connected, _is_interested), 1), else_=0)).label("interested"),
        )
        .group_by(trunc)
        .order_by(trunc)
    )
    stmt = filters.apply(stmt)
    rows = (await db.execute(stmt)).all()
    return [
        {
            "bucket": r.bucket.isoformat() if r.bucket else None,
            "total": int(r.total or 0),
            "connected": int(r.connected or 0),
            "interested": int(r.interested or 0),
        }
        for r in rows
    ]


# ---------------------------------------------------------------------------
# Funnel: Unique leads → Connected → Engaged → Interested → Top priority
# All stages are unique-lead counts (one phone = one count per stage).
# ---------------------------------------------------------------------------
async def call_funnel(db: AsyncSession, filters: MetricFilters) -> list[dict[str, Any]]:
    """Conversion funnel — clean 3-stage linear narrative, all in unique-lead basis.

        Unique leads → Connected → Engaged

    Why only 3 stages and not the previous 5:
    The old funnel ended in `Top priority` (Interested AND Callback). That
    forced the funnel to choose between Interested and Callback as the
    "fourth stage", which obscured the fact that they're mutually-exclusive
    sales-action buckets and Top priority is just one of three options.

    The 3-stage funnel tells the macro story (reach → pickup → real
    conversation). The granular breakdown of "what happened in those
    conversations" is rendered separately by the frontend as 4 mutually-
    exclusive cards (Interested only / Top priority / Callback only /
    No intent), which all sum back to Connected. That keeps the funnel
    visually clean while preserving every lead's home in the breakdown.

    Engaged isn't strictly a parent of the action-bucket cards (a few rare
    Hunar edge cases assign interest_level/callback without an ENGAGED tag),
    so it stays in the funnel as a quality gate but doesn't drive the
    breakdown — the breakdown sums to Connected, not Engaged.
    """
    m = await compute_overview_metrics(db, filters)
    leads     = int(m.get("unique_leads")           or 0)
    connected = int(m.get("unique_connected_leads") or 0)
    engaged   = int(m.get("unique_engaged_leads")   or 0)

    stages = [
        {
            "key": "leads",
            "stage": "Unique leads",
            "count": leads,
            "_parent": None,
            "definition": (
                "Distinct phone numbers dialed in this window. Same person "
                "called in 5 attempts across 2 campaigns = 1 lead here. "
                "This is the universe everything below funnels from."
            ),
        },
        {
            "key": "connected",
            "stage": "Connected",
            "count": connected,
            "_parent": leads,
            "definition": (
                "Leads we actually reached — at least one attempt completed "
                "with a HUMAN pickup. Excludes voicemail (answered_by=MACHINE), "
                "in-progress retries, and hard failures."
            ),
        },
        {
            "key": "engaged",
            "stage": "Engaged",
            "count": engaged,
            "_parent": connected,
            "definition": (
                "Connected leads who had a real back-and-forth with the bot "
                "(engagement_status=ENGAGED on at least one attempt). Quality "
                "gate — tells you whether the bot got a fair listen, not "
                "whether the prospect was interested."
            ),
        },
    ]

    # Drop-off rates — vs. each stage's true parent (the actionable conversion
    # rate) and vs. top of funnel (the cumulative survival rate).
    top = stages[0]["count"]
    for s in stages:
        parent = s.pop("_parent")
        s["rate_of_previous"] = (s["count"] / parent) if parent else None
        s["rate_of_top"] = (s["count"] / top) if top else 0.0

    return stages


# ---------------------------------------------------------------------------# ---------------------------------------------------------------------------
# Vendor comparison — same metrics, broken down per vendor
# ---------------------------------------------------------------------------
async def vendor_comparison(db: AsyncSession, filters: MetricFilters) -> list[dict[str, Any]]:
    _valid_phone_vc = case(
        (and_(CallLog.mobile_number.isnot(None), CallLog.mobile_number != ""), CallLog.mobile_number)
    )
    stmt = (
        select(
            Vendor.id.label("vendor_id"),
            Vendor.slug.label("vendor_slug"),
            Vendor.name.label("vendor_name"),
            func.count(CallLog.id).label("row_count"),       # rate denominator
            _total_dials_expr.label("total"),                # display value
            func.count(distinct(_valid_phone_vc)).label("unique_leads"),
            func.sum(case((_is_connected, 1), else_=0)).label("connected"),
            func.avg(case((_is_connected, CallLog.duration_seconds))).label("avg_dur"),
            func.sum(case((and_(_is_connected, _is_engaged), 1), else_=0)).label("engaged"),
            func.sum(case((and_(_is_connected, _is_interested), 1), else_=0)).label("interested"),
            func.sum(case((and_(_is_connected, _has_follow_up), 1), else_=0)).label("follow_up"),
        )
        .join(CallLog, CallLog.vendor_id == Vendor.id)
        .group_by(Vendor.id, Vendor.slug, Vendor.name)
    )
    stmt = filters.apply(stmt)
    rows = (await db.execute(stmt)).all()
    out = []
    for r in rows:
        total = int(r.total or 0)
        row_count = int(r.row_count or 0)
        connected = int(r.connected or 0)
        unique_leads = int(r.unique_leads or 0)
        out.append({
            "vendor_id": str(r.vendor_id),
            "vendor_slug": r.vendor_slug,
            "vendor_name": r.vendor_name,
            "total_calls": total,                            # dial attempts
            "unique_leads": unique_leads,
            "connected_calls": connected,
            "avg_duration_seconds": float(r.avg_dur or 0),
            "connection_rate": _safe_div(connected, row_count),
            "engagement_rate": _safe_div(int(r.engaged or 0), connected),
            "interest_rate": _safe_div(int(r.interested or 0), connected),
            "follow_up_rate": _safe_div(int(r.follow_up or 0), connected),
            "attempts_per_lead": (total / unique_leads) if unique_leads else 0.0,
        })
    return out


# ---------------------------------------------------------------------------
# Campaign-level breakdown (for vendor analysis page)
# ---------------------------------------------------------------------------
async def campaign_breakdown(db: AsyncSession, filters: MetricFilters) -> list[dict[str, Any]]:
    stmt = (
        select(
            Campaign.id.label("campaign_id"),
            Campaign.name.label("campaign_name"),
            Campaign.display_name.label("display_name_db"),
            Campaign.vendor_request_id,
            Campaign.vendor_campaign_id,
            Campaign.vendor_id,
            Vendor.name.label("vendor_name"),
            Campaign.started_at,
            func.count(CallLog.id).label("row_count"),       # unique leads in slice = rate denominator
            _total_dials_expr.label("total"),                # total dial attempts
            func.sum(case((_is_connected, 1), else_=0)).label("connected"),
            func.sum(case((and_(_is_connected, _is_engaged), 1), else_=0)).label("engaged"),
            func.sum(case((and_(_is_connected, _is_interested), 1), else_=0)).label("interested"),
        )
        .join(CallLog, CallLog.campaign_id == Campaign.id)
        .join(Vendor, Vendor.id == Campaign.vendor_id)
        .group_by(Campaign.id, Campaign.name, Campaign.display_name, Campaign.vendor_request_id,
                  Campaign.vendor_campaign_id, Campaign.vendor_id, Vendor.name, Campaign.started_at)
        .order_by(Campaign.started_at.desc())
    )
    stmt = filters.apply(stmt)
    rows = (await db.execute(stmt)).all()
    out = []
    for r in rows:
        # Display label precedence:
        #   1. Campaign.display_name (user-set / synced from vendor UI)
        #   2. "Campaign <short hunar_campaign_id>" if we have one
        #   3. "Campaign <short request_id>" fallback
        if r.display_name_db:
            display = r.display_name_db
        elif r.vendor_campaign_id:
            display = f"Campaign {r.vendor_campaign_id[:8]}"
        else:
            display = f"Campaign {r.vendor_request_id[:8]}"

        row_count = int(r.row_count or 0)
        connected = int(r.connected or 0)
        engaged = int(r.engaged or 0)
        interested = int(r.interested or 0)
        out.append({
            "campaign_id": str(r.campaign_id),
            "campaign_name": r.campaign_name,
            "display_name": display,
            "vendor_id": str(r.vendor_id),
            "vendor_name": r.vendor_name,
            "started_at": r.started_at.isoformat() if r.started_at else None,
            "unique_leads": row_count,                       # denominator for connection_rate
            "total_calls": int(r.total or 0),                # total dial attempts
            "connected_calls": connected,
            "engaged_calls": engaged,
            "interested_calls": interested,
            "connection_rate": _safe_div(connected, row_count),
            "engagement_rate": _safe_div(engaged, connected),
            "interest_rate": _safe_div(interested, connected),
        })
    return out



# ---------------------------------------------------------------------------
# Hourly breakdown — what hour of day are we calling, and does it work?
# Bucketed in IST (Asia/Kolkata) since the calling operation is India-based.
# ---------------------------------------------------------------------------
async def hourly_breakdown(db: AsyncSession, filters: MetricFilters) -> list[dict[str, Any]]:
    # date_part('hour', ts AT TIME ZONE 'Asia/Kolkata') gives 0..23.
    # Buckets by ACTIVITY time (when the call ended) so the hour breakdown
    # reflects when the dialer was actually working, not when leads were
    # queued for it.
    hour_expr = func.date_part(
        "hour",
        func.timezone("Asia/Kolkata", _activity_at),
    )
    stmt = (
        select(
            hour_expr.label("hour"),
            func.count(CallLog.id).label("row_count"),
            _total_dials_expr.label("total"),
            func.sum(case((_is_connected, 1), else_=0)).label("connected"),
            func.avg(case((_is_connected, CallLog.duration_seconds))).label("avg_dur"),
            func.sum(case((and_(_is_connected, _is_engaged), 1), else_=0)).label("engaged"),
            func.sum(case((and_(_is_connected, _is_interested), 1), else_=0)).label("interested"),
        )
        .group_by(hour_expr)
        .order_by(hour_expr)
    )
    stmt = filters.apply(stmt)
    rows = (await db.execute(stmt)).all()
    out = []
    for r in rows:
        total = int(r.total or 0)
        row_count = int(r.row_count or 0)
        connected = int(r.connected or 0)
        engaged = int(r.engaged or 0)
        interested = int(r.interested or 0)
        out.append({
            "hour": int(r.hour),
            "total_calls": total,
            "connected_calls": connected,
            "engaged_calls": engaged,
            "interested_calls": interested,
            "avg_duration_seconds": float(r.avg_dur or 0),
            "connection_rate": _safe_div(connected, row_count),
            "engagement_rate": _safe_div(engaged, connected),
            "interest_rate": _safe_div(interested, connected),
        })
    return out

def default_window() -> tuple[datetime, datetime]:
    """Last 30 days, ending now."""
    end = datetime.utcnow()
    return end - timedelta(days=30), end


# ---------------------------------------------------------------------------
# Hourly Insights — full payload for the /hourly-insights page
# Returns: hour rollup, dow rollup, dow×hour heatmap matrix,
#          per-vendor hour split, per-campaign hour split
# Single endpoint, single fetch — frontend slices it.
# ---------------------------------------------------------------------------
_DOW_NAMES = {1: "Mon", 2: "Tue", 3: "Wed", 4: "Thu", 5: "Fri", 6: "Sat", 7: "Sun"}


def _hour_expr_ist():
    # Hour of activity (call-end if available, else upload time) in IST.
    # Keeps Hourly Insights aligned with Leads-page semantics.
    return func.date_part("hour", func.timezone("Asia/Kolkata", _activity_at))


def _dow_expr_ist():
    # ISODOW: 1=Mon ... 7=Sun -- intuitive sort order.
    # Same activity-date semantics as _hour_expr_ist.
    return func.extract("isodow", func.timezone("Asia/Kolkata", _activity_at))


def _bucket_row_to_dict(r, key: str) -> dict[str, Any]:
    """Shared shape: hour OR dow bucket → metric dict."""
    total = int(r.total or 0)            # dial attempts
    row_count = int(getattr(r, "row_count", None) or 0)  # leads in slice
    connected = int(r.connected or 0)
    engaged = int(r.engaged or 0)
    interested = int(r.interested or 0)
    callback = int(getattr(r, "callback", None) or 0)
    out = {
        "total_calls": total,
        "connected_calls": connected,
        "engaged_calls": engaged,
        "interested_calls": interested,
        "callback_calls": callback,
        "avg_duration_seconds": float(r.avg_dur or 0),
        "connection_rate": _safe_div(connected, row_count),
        "engagement_rate": _safe_div(engaged, connected),
        "interest_rate": _safe_div(interested, connected),
        "callback_rate": _safe_div(callback, connected),
    }
    if key == "hour":
        out["hour"] = int(r.hour)
    else:
        dow = int(r.dow)
        out["dow"] = dow
        out["dow_name"] = _DOW_NAMES.get(dow, str(dow))
    return out


async def _hour_breakdown(db: AsyncSession, filters: MetricFilters) -> list[dict[str, Any]]:
    h = _hour_expr_ist()
    stmt = (
        select(
            h.label("hour"),
            func.count(CallLog.id).label("row_count"),
            _total_dials_expr.label("total"),
            func.sum(case((_is_connected, 1), else_=0)).label("connected"),
            func.avg(case((_is_connected, CallLog.duration_seconds))).label("avg_dur"),
            func.sum(case((and_(_is_connected, _is_engaged), 1), else_=0)).label("engaged"),
            func.sum(case((and_(_is_connected, _is_interested), 1), else_=0)).label("interested"),
            func.sum(case((and_(_is_connected, _has_follow_up), 1), else_=0)).label("callback"),
        )
        .group_by(h)
        .order_by(h)
    )
    stmt = filters.apply(stmt)
    rows = (await db.execute(stmt)).all()
    return [_bucket_row_to_dict(r, "hour") for r in rows]


async def _dow_breakdown(db: AsyncSession, filters: MetricFilters) -> list[dict[str, Any]]:
    d = _dow_expr_ist()
    stmt = (
        select(
            d.label("dow"),
            func.count(CallLog.id).label("row_count"),
            _total_dials_expr.label("total"),
            func.sum(case((_is_connected, 1), else_=0)).label("connected"),
            func.avg(case((_is_connected, CallLog.duration_seconds))).label("avg_dur"),
            func.sum(case((and_(_is_connected, _is_engaged), 1), else_=0)).label("engaged"),
            func.sum(case((and_(_is_connected, _is_interested), 1), else_=0)).label("interested"),
            func.sum(case((and_(_is_connected, _has_follow_up), 1), else_=0)).label("callback"),
        )
        .group_by(d)
        .order_by(d)
    )
    stmt = filters.apply(stmt)
    rows = (await db.execute(stmt)).all()
    return [_bucket_row_to_dict(r, "dow") for r in rows]


async def _dow_hour_heatmap(db: AsyncSession, filters: MetricFilters) -> list[dict[str, Any]]:
    h = _hour_expr_ist()
    d = _dow_expr_ist()
    stmt = (
        select(
            d.label("dow"),
            h.label("hour"),
            func.count(CallLog.id).label("row_count"),
            _total_dials_expr.label("total"),
            func.sum(case((_is_connected, 1), else_=0)).label("connected"),
            func.avg(case((_is_connected, CallLog.duration_seconds))).label("avg_dur"),
            func.sum(case((and_(_is_connected, _is_engaged), 1), else_=0)).label("engaged"),
            func.sum(case((and_(_is_connected, _is_interested), 1), else_=0)).label("interested"),
            func.sum(case((and_(_is_connected, _has_follow_up), 1), else_=0)).label("callback"),
        )
        .group_by(d, h)
        .order_by(d, h)
    )
    stmt = filters.apply(stmt)
    rows = (await db.execute(stmt)).all()
    out = []
    for r in rows:
        total = int(r.total or 0)
        row_count = int(r.row_count or 0)
        connected = int(r.connected or 0)
        engaged = int(r.engaged or 0)
        interested = int(r.interested or 0)
        callback = int(r.callback or 0)
        dow = int(r.dow)
        out.append({
            "dow": dow,
            "dow_name": _DOW_NAMES.get(dow, str(dow)),
            "hour": int(r.hour),
            "total_calls": total,
            "connected_calls": connected,
            "engaged_calls": engaged,
            "interested_calls": interested,
            "callback_calls": callback,
            "avg_duration_seconds": float(r.avg_dur or 0),
            "connection_rate": _safe_div(connected, row_count),
            "engagement_rate": _safe_div(engaged, connected),
            "interest_rate": _safe_div(interested, connected),
            "callback_rate": _safe_div(callback, connected),
        })
    return out


async def _hour_by_vendor(db: AsyncSession, filters: MetricFilters) -> list[dict[str, Any]]:
    h = _hour_expr_ist()
    stmt = (
        select(
            Vendor.id.label("vendor_id"),
            Vendor.name.label("vendor_name"),
            h.label("hour"),
            func.count(CallLog.id).label("row_count"),
            _total_dials_expr.label("total"),
            func.sum(case((_is_connected, 1), else_=0)).label("connected"),
            func.avg(case((_is_connected, CallLog.duration_seconds))).label("avg_dur"),
            func.sum(case((and_(_is_connected, _is_engaged), 1), else_=0)).label("engaged"),
            func.sum(case((and_(_is_connected, _is_interested), 1), else_=0)).label("interested"),
            func.sum(case((and_(_is_connected, _has_follow_up), 1), else_=0)).label("callback"),
        )
        .join(CallLog, CallLog.vendor_id == Vendor.id)
        .group_by(Vendor.id, Vendor.name, h)
        .order_by(Vendor.name, h)
    )
    stmt = filters.apply(stmt)
    rows = (await db.execute(stmt)).all()

    # Group rows by vendor
    by_v: dict[str, dict[str, Any]] = {}
    for r in rows:
        vid = str(r.vendor_id)
        if vid not in by_v:
            by_v[vid] = {"vendor_id": vid, "vendor_name": r.vendor_name, "hours": []}
        total = int(r.total or 0)
        row_count = int(r.row_count or 0)
        connected = int(r.connected or 0)
        engaged = int(r.engaged or 0)
        interested = int(r.interested or 0)
        callback = int(r.callback or 0)
        by_v[vid]["hours"].append({
            "hour": int(r.hour),
            "total_calls": total,
            "connected_calls": connected,
            "engaged_calls": engaged,
            "interested_calls": interested,
            "callback_calls": callback,
            "avg_duration_seconds": float(r.avg_dur or 0),
            "connection_rate": _safe_div(connected, row_count),
            "engagement_rate": _safe_div(engaged, connected),
            "interest_rate": _safe_div(interested, connected),
            "callback_rate": _safe_div(callback, connected),
        })
    return list(by_v.values())


async def _hour_by_campaign(db: AsyncSession, filters: MetricFilters, top_n: int = 6) -> list[dict[str, Any]]:
    """Top N campaigns by volume in window, each with hourly breakdown."""
    # Identify top campaigns first — by dial volume, not row count
    top_stmt = (
        select(Campaign.id, _total_dials_expr.label("n"))
        .join(CallLog, CallLog.campaign_id == Campaign.id)
        .group_by(Campaign.id)
        .order_by(_total_dials_expr.desc())
        .limit(top_n)
    )
    top_stmt = filters.apply(top_stmt)
    top_ids = [r.id for r in (await db.execute(top_stmt)).all()]
    if not top_ids:
        return []

    h = _hour_expr_ist()
    stmt = (
        select(
            Campaign.id.label("campaign_id"),
            Campaign.name.label("campaign_name"),
            Campaign.display_name.label("display_name_db"),
            Campaign.vendor_request_id,
            Campaign.vendor_campaign_id,
            Vendor.name.label("vendor_name"),
            Campaign.started_at,
            h.label("hour"),
            func.count(CallLog.id).label("row_count"),
            _total_dials_expr.label("total"),
            func.sum(case((_is_connected, 1), else_=0)).label("connected"),
            func.avg(case((_is_connected, CallLog.duration_seconds))).label("avg_dur"),
            func.sum(case((and_(_is_connected, _is_engaged), 1), else_=0)).label("engaged"),
            func.sum(case((and_(_is_connected, _is_interested), 1), else_=0)).label("interested"),
            func.sum(case((and_(_is_connected, _has_follow_up), 1), else_=0)).label("callback"),
        )
        .join(CallLog, CallLog.campaign_id == Campaign.id)
        .join(Vendor, Vendor.id == Campaign.vendor_id)
        .where(Campaign.id.in_(top_ids))
        .group_by(Campaign.id, Campaign.name, Campaign.display_name, Campaign.vendor_request_id,
                  Campaign.vendor_campaign_id, Vendor.name, Campaign.started_at, h)
        .order_by(Campaign.started_at.desc().nulls_last(), h)
    )
    stmt = filters.apply(stmt)
    rows = (await db.execute(stmt)).all()

    by_c: dict[str, dict[str, Any]] = {}
    for r in rows:
        cid = str(r.campaign_id)
        if cid not in by_c:
            # Prefer Campaign.display_name → "Campaign <hunar_campaign_id>" → "Campaign <request_id>"
            if r.display_name_db:
                display = r.display_name_db
            elif r.vendor_campaign_id:
                display = f"Campaign {r.vendor_campaign_id[:8]}"
            else:
                display = f"Campaign {r.vendor_request_id[:8]}"
            by_c[cid] = {
                "campaign_id": cid,
                "campaign_name": r.campaign_name,
                "display_name": display,
                "hours": [],
            }
        total = int(r.total or 0)
        row_count = int(r.row_count or 0)
        connected = int(r.connected or 0)
        engaged = int(r.engaged or 0)
        interested = int(r.interested or 0)
        callback = int(r.callback or 0)
        by_c[cid]["hours"].append({
            "hour": int(r.hour),
            "total_calls": total,
            "connected_calls": connected,
            "engaged_calls": engaged,
            "interested_calls": interested,
            "callback_calls": callback,
            "avg_duration_seconds": float(r.avg_dur or 0),
            "connection_rate": _safe_div(connected, row_count),
            "engagement_rate": _safe_div(engaged, connected),
            "interest_rate": _safe_div(interested, connected),
            "callback_rate": _safe_div(callback, connected),
        })
    return list(by_c.values())


async def hourly_insights(db: AsyncSession, filters: MetricFilters) -> dict[str, Any]:
    """Single payload for the /hourly-insights page.

    All sub-queries share the same filter window so cross-cutting comparisons
    are consistent. Five sections:
      - hour_breakdown:   one row per hour 0..23 (only hours with data)
      - dow_breakdown:    one row per weekday 1..7 (only days with data)
      - heatmap:          dow × hour cells (only cells with data)
      - by_vendor:        per-vendor hour split
      - by_campaign:      top-6 campaigns by volume, each with hour split
    """
    return {
        "hour_breakdown":  await _hour_breakdown(db, filters),
        "dow_breakdown":   await _dow_breakdown(db, filters),
        "heatmap":         await _dow_hour_heatmap(db, filters),
        "by_vendor":       await _hour_by_vendor(db, filters),
        "by_campaign":     await _hour_by_campaign(db, filters),
    }


# ---------------------------------------------------------------------------
# Per-agent performance — answers "which AI script converts best?"
# ---------------------------------------------------------------------------
async def agent_breakdown(db: AsyncSession, filters: MetricFilters) -> list[dict[str, Any]]:
    from app.models import Agent  # local import to avoid circulars on module load

    stmt = (
        select(
            Agent.id.label("agent_id"),
            Agent.name.label("agent_name"),
            Agent.language.label("language"),
            Agent.voice_persona.label("voice_persona"),
            Vendor.name.label("vendor_name"),
            func.count(CallLog.id).label("row_count"),
            _total_dials_expr.label("total"),
            func.sum(case((_is_connected, 1), else_=0)).label("connected"),
            func.avg(case((_is_connected, CallLog.duration_seconds))).label("avg_dur"),
            func.sum(case((and_(_is_connected, _is_engaged), 1), else_=0)).label("engaged"),
            func.sum(case((and_(_is_connected, _is_interested), 1), else_=0)).label("interested"),
            func.sum(case((and_(_is_connected, _has_follow_up), 1), else_=0)).label("follow_up"),
        )
        .join(CallLog, CallLog.agent_id == Agent.id)
        .join(Vendor, Vendor.id == Agent.vendor_id)
        .group_by(Agent.id, Agent.name, Agent.language, Agent.voice_persona, Vendor.name)
        .order_by(_total_dials_expr.desc())
    )
    stmt = filters.apply(stmt)
    rows = (await db.execute(stmt)).all()
    out = []
    for r in rows:
        total = int(r.total or 0)
        row_count = int(r.row_count or 0)
        connected = int(r.connected or 0)
        out.append({
            "agent_id": str(r.agent_id),
            "agent_name": r.agent_name,
            "vendor_name": r.vendor_name,
            "language": r.language,
            "voice_persona": r.voice_persona,
            "total_calls": total,
            "connected_calls": connected,
            "avg_duration_seconds": float(r.avg_dur or 0),
            "connection_rate": _safe_div(connected, row_count),
            "engagement_rate": _safe_div(int(r.engaged or 0), connected),
            "interest_rate": _safe_div(int(r.interested or 0), connected),
            "follow_up_rate": _safe_div(int(r.follow_up or 0), connected),
        })
    return out



# ---------------------------------------------------------------------------
# Outcome distribution — Hunar-style taxonomy built from our raw fields.
# Two views:
#   by_call: every call counted, grouped by outcome
#   by_lead: deduped to last call per lead (mobile_number), then grouped
# ---------------------------------------------------------------------------
def _outcome_case():
    """SQL CASE expression mapping (status, answered_by, result fields, duration)
    onto a clean outcome label. Order matters — first match wins."""
    return case(
        # Pre-call states
        (CallLog.status == "SCHEDULED", literal("Scheduled (not yet dialed)")),
        (CallLog.status == "FAILED", literal("Failed (vendor)")),
        (CallLog.status == "CANCELLED", literal("Cancelled")),
        # Connection failures
        (and_(CallLog.status == "NOT_CONNECTED", CallLog.answered_by == "MACHINE"), literal("Voicemail")),
        (CallLog.status == "NOT_CONNECTED", literal("Phone Not Answered")),
        # Connected — but answered_by is MACHINE means a voicemail picked up
        (CallLog.answered_by == "MACHINE", literal("Voicemail")),
        # Connected — outcomes from result JSONB
        (CallLog.result["next_step_interest"].astext == "CALLBACK", literal("Callback Booked")),
        (CallLog.result["objection_type"].astext == "NOT_INTERESTED", literal("Not Interested")),
        (CallLog.result["objection_type"].astext == "TIME", literal("Objection: Time")),
        (CallLog.result["objection_type"].astext == "FEES", literal("Objection: Fees")),
        (CallLog.result["objection_type"].astext == "CAREER_CONFUSION", literal("Objection: Career")),
        (and_(CallLog.duration_seconds.isnot(None), CallLog.duration_seconds < 15), literal("Short Hangup")),
        (CallLog.result["interest_level"].astext == "HIGH", literal("High Interest")),
        (CallLog.result["interest_level"].astext == "MEDIUM", literal("Medium Interest")),
        (CallLog.result["interest_level"].astext == "LOW", literal("Low Interest")),
        (CallLog.result["interest_level"].astext.in_(["Not Covered", "NOT AVAILABLE"]), literal("Connected — Outcome Unclear")),
        else_=literal("Other"),
    )


async def outcome_distribution(db: AsyncSession, filters: MetricFilters) -> dict[str, list[dict[str, Any]]]:
    """Return {by_call: [...], by_lead: [...]} with outcome counts + percentages.
    by_lead deduplicates to the most recent call per mobile_number.
    """
    # ---------- by_call ----------
    outcome = _outcome_case().label("outcome")
    call_stmt = select(outcome, func.count().label("n"))
    call_stmt = filters.apply(call_stmt).group_by("outcome").order_by(desc("n"))
    call_rows = (await db.execute(call_stmt)).all()
    total_calls = sum(int(r.n) for r in call_rows) or 1

    by_call = [
        {"outcome": r.outcome or "Other", "count": int(r.n), "pct": int(r.n) / total_calls}
        for r in call_rows
    ]

    # ---------- by_lead ----------
    # Inner query: rank calls per mobile_number (latest first); take rn=1.
    # We do this in two SELECTs because window functions can't combine with GROUP BY easily.
    valid_phone = and_(CallLog.mobile_number.isnot(None), CallLog.mobile_number != "")
    rn = func.row_number().over(
        partition_by=CallLog.mobile_number,
        order_by=[CallLog.started_at.desc().nullslast(), CallLog.vendor_created_at.desc()],
    ).label("rn")

    inner = select(
        outcome,
        rn,
    ).where(valid_phone)
    inner = filters.apply(inner).subquery()

    lead_stmt = select(inner.c.outcome, func.count().label("n")).where(inner.c.rn == 1).group_by(inner.c.outcome).order_by(desc("n"))
    lead_rows = (await db.execute(lead_stmt)).all()
    total_leads = sum(int(r.n) for r in lead_rows) or 1

    by_lead = [
        {"outcome": r.outcome or "Other", "count": int(r.n), "pct": int(r.n) / total_leads}
        for r in lead_rows
    ]

    return {"by_call": by_call, "by_lead": by_lead}


# ---------------------------------------------------------------------------
# Dial frequency / retry distribution — for each "N attempts", how many unique
# leads got exactly that many. Sum of leads here = unique_leads on Overview.
# Useful for spotting retry waste (e.g. 100 leads got 5+ attempts each = 500
# dial slots burned chasing the same numbers) and for verifying that vendor
# max_retries config matches expectation.
# ---------------------------------------------------------------------------
async def attempts_distribution(db: AsyncSession, filters: MetricFilters) -> dict[str, Any]:
    """
    True dial frequency per lead. Uses Hunar's `retry_count` (= retries used)
    on each call_log row. Total attempts on a row = retry_count + 1 (one
    initial dial + N retries). Sum across rows for the same mobile_number =
    total times that lead has been dialed.

    Edge case: a SCHEDULED row with retry_count=0 and started_at=NULL means
    the lead is queued but Hunar hasn't even started dialing yet → 0 attempts.

    Per bucket we also report:
      - leads:        unique leads with that exact attempt count
      - connected:    leads in this bucket who picked up (HUMAN, COMPLETED) at
                      least once across all their call_log rows
      - connect_rate: connected / leads (the cohort's pickup rate)

    Why this matters: when retry budget is wasted on dead leads, those leads
    pile up in the high-attempt buckets with near-zero connect_rate. Easy
    visual signal for "stop retrying after N attempts".
    """
    valid_phone = and_(CallLog.mobile_number.isnot(None), CallLog.mobile_number != "")

    # Per-row attempts: retry_count + 1, except truly never-dialed = 0
    attempts_per_row = case(
        (and_(
            CallLog.status == "SCHEDULED",
            CallLog.retry_count == 0,
            CallLog.started_at.is_(None),
        ), literal(0)),
        else_=CallLog.retry_count + literal(1),
    )

    # Per-row "did this row connect (human pickup)?"
    connected_per_row = case(
        (and_(
            CallLog.lifecycle_status == "COMPLETED",
            CallLog.answered_by == "HUMAN",
        ), literal(1)),
        else_=literal(0),
    )

    # Inner: per-lead total attempts + ever_connected flag (max=1 if any row connected)
    inner = select(
        CallLog.mobile_number.label("mobile"),
        func.sum(attempts_per_row).label("attempts"),
        func.max(connected_per_row).label("ever_connected"),
    ).where(valid_phone).group_by(CallLog.mobile_number)
    inner = filters.apply(inner).subquery()

    # Outer: histogram by total attempts, with connect counts
    outer = (
        select(
            inner.c.attempts.label("attempts"),
            func.count().label("leads"),
            func.coalesce(func.sum(inner.c.ever_connected), literal(0)).label("connected"),
        )
        .group_by(inner.c.attempts)
        .order_by(inner.c.attempts.asc())
    )
    rows = (await db.execute(outer)).all()

    total_leads = sum(int(r.leads) for r in rows) or 0
    total_connected = sum(int(r.connected or 0) for r in rows) or 0
    total_calls = sum(int(r.attempts) * int(r.leads) for r in rows) or 0
    leads_div = total_leads or 1

    out_rows: list[dict[str, Any]] = []
    for r in rows:
        attempts = int(r.attempts)
        leads = int(r.leads)
        connected = int(r.connected or 0)
        out_rows.append({
            "attempts": attempts,
            "leads": leads,
            "connected": connected,
            "pct_of_leads": leads / leads_div,
            "connect_rate": (connected / leads) if leads else 0.0,
        })

    return {
        "rows": out_rows,
        "total_leads": total_leads,
        "total_connected": total_connected,
        "total_calls": total_calls,
    }
