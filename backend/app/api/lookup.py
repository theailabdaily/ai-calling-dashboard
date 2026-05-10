"""BDA phone-number lookup tool.

Two endpoints:

  GET  /api/lookup?phone=<any-format>
       Returns a per-lead summary (history of calls, outcomes, durations,
       interest level, objection text). VENDOR/AGENT/CAMPAIGN identifiers
       are deliberately stripped — BDAs see what happened, not who did it.

  GET  /api/lookup/recording/{call_id}
       Streams the recording audio through this backend so the underlying
       Google Cloud Storage / vendor URL never reaches the browser. Without
       this proxy, anyone with DevTools could read the URL and learn the
       vendor name (the URL contains hunar-voice-agents-prod/plivo strings).
       Stream is audio/wav, 1-hour cache.

Design notes:
- No auth gate — internal tool, deployed under a separate route. Rate-limit
  via a simple in-process counter so a typo loop can't smash the DB.
- Phone normalization is forgiving: strips spaces/dashes/parens, accepts
  10-digit, 11-digit (leading 0), 12-digit (91 prefix), or 13-digit (+91).
  Always normalized to '+91XXXXXXXXXX' before query.
"""
from __future__ import annotations

import re
import time
from collections import defaultdict
from typing import Any
from uuid import UUID

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models import CallLog
from app.schemas import LookupCall, LookupResult, LookupSummary

router = APIRouter(prefix="/api/lookup", tags=["lookup"])


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
_NON_DIGIT = re.compile(r"\D+")


def normalize_phone(raw: str) -> str | None:
    """Best-effort normalize Indian mobile to +91XXXXXXXXXX. Returns None on bad input."""
    if not raw:
        return None
    digits = _NON_DIGIT.sub("", raw)
    # Strip a leading 0 (some CRMs export "09876543210")
    if len(digits) == 11 and digits.startswith("0"):
        digits = digits[1:]
    # Strip a country-code prefix
    if len(digits) == 12 and digits.startswith("91"):
        digits = digits[2:]
    if len(digits) == 13 and digits.startswith("091"):
        digits = digits[3:]
    if len(digits) != 10:
        return None
    # Mobile numbers in India start 6/7/8/9 — anything else is a typo or landline
    if digits[0] not in "6789":
        return None
    return "+91" + digits


# Tiny in-process rate limiter: 30 lookups / 60 sec / IP. Not bulletproof —
# just a guard against accidental loops or browser auto-retry storms.
_RATE_BUCKETS: dict[str, list[float]] = defaultdict(list)
_RATE_WINDOW_SEC = 60.0
_RATE_MAX = 30


def _rate_check(ip: str) -> None:
    now = time.monotonic()
    bucket = _RATE_BUCKETS[ip]
    # Drop expired hits
    cutoff = now - _RATE_WINDOW_SEC
    bucket[:] = [t for t in bucket if t > cutoff]
    if len(bucket) >= _RATE_MAX:
        raise HTTPException(status_code=429, detail="Too many lookups. Wait a moment.")
    bucket.append(now)


def _interest_label(call: CallLog) -> str | None:
    """Human-readable interest summary for the BDA — derived from result JSONB."""
    r = call.result or {}
    interest = (r.get("interest_level") or "").upper()
    if interest in ("HIGH", "MEDIUM", "LOW"):
        return interest.title()
    objection = (r.get("objection_type") or "").upper()
    objection_map = {
        "NOT_INTERESTED": "Not interested",
        "TIME": "Time / busy",
        "FEES": "Fees concern",
        "CAREER_CONFUSION": "Career confusion",
    }
    if objection in objection_map:
        return objection_map[objection]
    next_step = (r.get("next_step_interest") or "").upper()
    if next_step == "CALLBACK":
        return "Callback booked"
    return None


def _serialize_call(call: CallLog) -> LookupCall:
    r = call.result or {}
    return LookupCall(
        # NB: id is included so the frontend can hit the recording-proxy
        # endpoint, but no vendor IDs of any kind go out.
        id=call.id,
        when=call.started_at or call.vendor_created_at,
        status=call.lifecycle_status or "UNKNOWN",
        answered_by=call.answered_by or "UNKNOWN",
        duration_seconds=float(call.duration_seconds or 0),
        retry_count=int(call.retry_count or 0),
        has_recording=bool(call.recording_url),
        interest=_interest_label(call),
        objection_text=(r.get("objections_verbatim") or None) if isinstance(r.get("objections_verbatim"), str) else None,
        next_step=r.get("next_step_interest") or None,
        follow_up_at=r.get("follow_up_time") or None,
        language=call.language or None,
    )


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------
@router.get("", response_model=LookupResult)
async def lookup(
    request: Request,
    phone: str = Query(..., description="Phone number — any format. Will be normalized to +91XXXXXXXXXX."),
    db: AsyncSession = Depends(get_db),
):
    _rate_check(request.client.host if request.client else "unknown")

    normalized = normalize_phone(phone)
    if not normalized:
        return LookupResult(
            normalized_phone=None,
            input_phone=phone,
            found=False,
            summary=None,
            calls=[],
        )

    stmt = (
        select(CallLog)
        .where(CallLog.mobile_number == normalized)
        .order_by(CallLog.started_at.desc().nullslast(), CallLog.vendor_created_at.desc())
    )
    rows = (await db.execute(stmt)).scalars().all()

    if not rows:
        return LookupResult(
            normalized_phone=normalized,
            input_phone=phone,
            found=False,
            summary=None,
            calls=[],
        )

    calls = [_serialize_call(c) for c in rows]

    # Build a top-line summary the BDA can read in 2 seconds
    total_attempts = sum((c.retry_count + 1) for c in calls)
    connected = sum(1 for c in calls if c.status == "COMPLETED" and c.answered_by == "HUMAN")
    longest_dur = max((c.duration_seconds for c in calls), default=0.0)

    # Last meaningful interest signal (latest call with an interest label)
    latest_interest = next((c.interest for c in calls if c.interest), None)
    latest_objection = next((c.objection_text for c in calls if c.objection_text), None)
    latest_followup = next((c.follow_up_at for c in calls if c.follow_up_at), None)

    callee_name = next((c for c in rows if c.callee_name), None)
    callee_name_str = callee_name.callee_name if callee_name else None

    summary = LookupSummary(
        callee_name=callee_name_str,
        total_calls=len(calls),
        total_attempts=total_attempts,
        connected_count=connected,
        longest_duration_seconds=float(longest_dur),
        latest_interest=latest_interest,
        latest_objection=latest_objection,
        latest_follow_up=latest_followup,
        first_call_at=rows[-1].started_at or rows[-1].vendor_created_at,
        last_call_at=rows[0].started_at or rows[0].vendor_created_at,
    )

    return LookupResult(
        normalized_phone=normalized,
        input_phone=phone,
        found=True,
        summary=summary,
        calls=calls,
    )


@router.get("/recording/{call_id}")
async def get_recording(
    call_id: UUID,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """Streams call recording through this backend so the underlying vendor URL
    is never exposed to the browser. The browser only ever sees /api/lookup/recording/{uuid}."""
    _rate_check(request.client.host if request.client else "unknown")

    call = (await db.execute(select(CallLog).where(CallLog.id == call_id))).scalar_one_or_none()
    if not call or not call.recording_url:
        raise HTTPException(status_code=404, detail="Recording not found")

    # Stream the audio. We pass through the upstream Content-Type and let the
    # browser <audio> element handle range requests via the upstream server.
    upstream_url = call.recording_url

    async def iter_stream():
        async with httpx.AsyncClient(timeout=30.0) as client:
            async with client.stream("GET", upstream_url) as resp:
                if resp.status_code >= 400:
                    raise HTTPException(status_code=502, detail="Recording unavailable")
                async for chunk in resp.aiter_bytes(chunk_size=64 * 1024):
                    yield chunk

    return StreamingResponse(
        iter_stream(),
        media_type="audio/wav",
        headers={
            # Cache for an hour — the recording never changes once written.
            "Cache-Control": "private, max-age=3600",
            # Force download-friendly filename if BDA chooses to save (still no vendor name)
            "Content-Disposition": f'inline; filename="call-{call_id}.wav"',
        },
    )
