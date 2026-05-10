"""BDA phone-number lookup tool.

Two endpoints:
  GET  /api/lookup?phone=<any-format>      — per-lead summary + per-call history
  GET  /api/lookup/recording/{call_id}     — proxied recording stream

VENDOR/AGENT/CAMPAIGN identifiers are stripped from all responses.
Recording URL is proxied so the underlying GCS/vendor URL never leaks.
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
# Phone normalization
# ---------------------------------------------------------------------------
_NON_DIGIT = re.compile(r"\D+")


def normalize_phone(raw: str) -> str | None:
    """Best-effort normalize Indian mobile to +91XXXXXXXXXX."""
    if not raw:
        return None
    digits = _NON_DIGIT.sub("", raw)
    if len(digits) == 11 and digits.startswith("0"):
        digits = digits[1:]
    if len(digits) == 12 and digits.startswith("91"):
        digits = digits[2:]
    if len(digits) == 13 and digits.startswith("091"):
        digits = digits[3:]
    if len(digits) != 10:
        return None
    if digits[0] not in "6789":
        return None
    return "+91" + digits


# ---------------------------------------------------------------------------
# Rate limit (in-process; sufficient against typo loops, not adversaries)
# ---------------------------------------------------------------------------
_RATE_BUCKETS: dict[str, list[float]] = defaultdict(list)
_RATE_WINDOW_SEC = 60.0
_RATE_MAX = 30


def _rate_check(ip: str) -> None:
    now = time.monotonic()
    bucket = _RATE_BUCKETS[ip]
    cutoff = now - _RATE_WINDOW_SEC
    bucket[:] = [t for t in bucket if t > cutoff]
    if len(bucket) >= _RATE_MAX:
        raise HTTPException(status_code=429, detail="Too many lookups. Wait a moment.")
    bucket.append(now)


# ---------------------------------------------------------------------------
# Summary generation — turns the structured `result` JSONB into plain English
# ---------------------------------------------------------------------------

# Map raw codes to BDA-friendly phrases
_OBJECTION_PHRASES = {
    "TIME": "said timing wasn't right",
    "NOT_INTERESTED": "not interested",
    "ALREADY_PREPARING": "already preparing on their own",
    "FEES": "raised concern about fees",
    "CAREER_CONFUSION": "unsure about career direction",
    "AGE": "age concern",
    "OTHER": None,                   # fall through to verbatim
    "Not Covered": None,             # don't mention — means we didn't ask
    "NOT AVAILABLE": None,           # didn't pick up
}

_INTEREST_PHRASES = {
    "HIGH": "high interest",
    "MEDIUM": "medium interest",
    "LOW": "low interest",
    "Highly Interested": "high interest",
    "Interested": "interest",
}

_ENGAGEMENT_PHRASES = {
    "HIGH": "engaged actively",
    "MEDIUM": "moderately engaged",
    "LOW": "low engagement",
}

_INTENT_PHRASES = {
    "SERIOUS": "serious about preparation",
    "EXPLORING": "still exploring options",
    "CASUAL": "casually curious",
}

_ATTEMPT_PHRASES = {
    "FIRST_ATTEMPT": "first-time aspirant",
    "REPEAT_ATTEMPT": "repeat attempt",
    "First Attempt": "first-time aspirant",
}

_NEXT_STEP_PHRASES = {
    "CALLBACK": "asked for a callback",
    "DEMO": "wanted a demo",
    "ENROL": "ready to enrol",
    "NONE": None,
}


def _clean(v: Any) -> str | None:
    """Strip placeholder values like 'Not Answered', 'Not Covered', 'NA', empty strings."""
    if v is None:
        return None
    if not isinstance(v, str):
        return str(v) if v else None
    s = v.strip()
    if not s:
        return None
    if s.lower() in ("not answered", "not covered", "not captured", "na", "n/a", "not available", "unknown"):
        return None
    return s


def _summarize_call(call: CallLog) -> str | None:
    """Return a 1-2 sentence summary of what happened on this call.
    Returns None if there's nothing meaningful to say (e.g. didn't pick up)."""
    if call.lifecycle_status != "COMPLETED":
        return None
    if call.answered_by != "HUMAN":
        return None
    r = call.result or {}
    if not r:
        return None

    parts: list[str] = []

    # Lead profile (Schema A — SSC/Banking/UPSC NET)
    subject = _clean(r.get("subject"))
    target = _clean(r.get("target"))
    attempt = _clean(r.get("attempt"))
    intent = _clean(r.get("preparation_intent"))

    # Lead profile (Schema B — UPSC CSE)
    current_goal = _clean(r.get("current_goal"))
    target_year = _clean(r.get("target_year"))
    profile = _clean(r.get("profile"))
    prep_status = _clean(r.get("prep_status"))
    biggest_challenge = _clean(r.get("biggest_challenge"))

    # Build the "who and what" clause
    profile_bits: list[str] = []
    if attempt and attempt in _ATTEMPT_PHRASES:
        profile_bits.append(_ATTEMPT_PHRASES[attempt])
    if target:
        if subject:
            profile_bits.append(f"preparing for {target} ({subject})")
        else:
            profile_bits.append(f"preparing for {target}")
    elif current_goal:
        if target_year:
            profile_bits.append(f"preparing for {current_goal} ({target_year})")
        else:
            profile_bits.append(f"preparing for {current_goal}")
    if profile and profile.lower() not in ("not answered",):
        profile_bits.append(profile.lower())
    if intent and intent in _INTENT_PHRASES:
        profile_bits.append(_INTENT_PHRASES[intent])
    elif prep_status:
        profile_bits.append(prep_status.lower())

    if profile_bits:
        parts.append("Lead is " + ", ".join(profile_bits) + ".")

    # Engagement / interest signal
    sig_bits: list[str] = []
    interest = _clean(r.get("interest_level")) or _clean(r.get("upsc_interest"))
    engagement = _clean(r.get("engagement_level"))
    if interest:
        phrase = _INTEREST_PHRASES.get(interest, f"{interest.lower()} interest")
        sig_bits.append(f"showed {phrase}")
    if engagement and engagement in _ENGAGEMENT_PHRASES:
        sig_bits.append(_ENGAGEMENT_PHRASES[engagement])

    # Objection
    objection_type = _clean(r.get("objection_type"))
    objection_verbatim = _clean(r.get("objections_verbatim"))
    if objection_type:
        phrase = _OBJECTION_PHRASES.get(objection_type)
        if phrase:
            sig_bits.append(phrase)
        elif objection_verbatim:
            # Fall back to verbatim quote, capped at ~80 chars
            quoted = objection_verbatim[:80] + ("…" if len(objection_verbatim) > 80 else "")
            sig_bits.append(f'mentioned: "{quoted}"')

    # Next step
    next_step = _clean(r.get("next_step_interest"))
    if next_step and next_step in _NEXT_STEP_PHRASES:
        ns_phrase = _NEXT_STEP_PHRASES[next_step]
        if ns_phrase:
            sig_bits.append(ns_phrase)
    follow_up = _clean(r.get("follow_up_time")) or _clean(r.get("callback_time"))
    if follow_up:
        sig_bits.append(f"follow-up at {follow_up}")

    # Schema B: biggest_challenge is gold — surface it
    if biggest_challenge:
        sig_bits.append(f'main challenge: {biggest_challenge.lower()}')

    if sig_bits:
        parts.append("On this call, " + ", ".join(sig_bits) + ".")

    if not parts:
        # Nothing structured but call did happen — last-ditch verbatim
        if objection_verbatim:
            return f'Lead said: "{objection_verbatim[:120]}"'
        return None

    return " ".join(parts)


def _build_narrative(calls: list[CallLog]) -> str | None:
    """Build a 2-3 sentence overall narrative across all calls."""
    if not calls:
        return None

    total = len(calls)
    connected = sum(1 for c in calls if c.lifecycle_status == "COMPLETED" and c.answered_by == "HUMAN")
    not_connected = total - connected

    # Pick the most recent connected call as the source for "where things stand"
    latest_connected = next(
        (c for c in calls if c.lifecycle_status == "COMPLETED" and c.answered_by == "HUMAN"),
        None,
    )

    parts: list[str] = []

    # Volume sentence
    if total == 1:
        if connected == 1:
            parts.append("Picked up on the only call so far.")
        else:
            parts.append("Has been called once but didn't pick up.")
    else:
        if connected == 0:
            parts.append(f"Called {total} times, never picked up.")
        elif not_connected == 0:
            parts.append(f"Called {total} times, picked up every time.")
        else:
            parts.append(f"Called {total} times, picked up {connected}.")

    # Profile from latest connected call
    if latest_connected and latest_connected.result:
        r = latest_connected.result
        target = _clean(r.get("target")) or _clean(r.get("current_goal"))
        subject = _clean(r.get("subject"))
        attempt = _clean(r.get("attempt"))
        attempt_phrase = _ATTEMPT_PHRASES.get(attempt, "") if attempt else ""

        if target:
            who = []
            if attempt_phrase:
                who.append(attempt_phrase.capitalize())
            else:
                who.append("Aspirant")
            if subject:
                who.append(f"for {target} ({subject})")
            else:
                who.append(f"for {target}")
            parts.append(" ".join(who) + ".")

        # Latest interest + objection
        interest = _clean(r.get("interest_level")) or _clean(r.get("upsc_interest"))
        objection_type = _clean(r.get("objection_type"))
        next_step = _clean(r.get("next_step_interest"))
        follow_up = _clean(r.get("follow_up_time")) or _clean(r.get("callback_time"))

        latest_bits: list[str] = []
        if interest:
            phrase = _INTEREST_PHRASES.get(interest, interest.lower() + " interest")
            latest_bits.append(f"latest call showed {phrase}")
        if objection_type:
            obj_phrase = _OBJECTION_PHRASES.get(objection_type)
            if obj_phrase:
                latest_bits.append(obj_phrase)
        if next_step == "CALLBACK" and follow_up:
            latest_bits.append(f"asked for callback at {follow_up}")
        elif next_step == "CALLBACK":
            latest_bits.append("asked for callback")

        if latest_bits:
            parts.append(", ".join(latest_bits).capitalize() + ".")

    return " ".join(parts) if parts else None


# ---------------------------------------------------------------------------
# Build response objects
# ---------------------------------------------------------------------------
def _interest_label(call: CallLog) -> str | None:
    r = call.result or {}
    interest = (r.get("interest_level") or "").upper()
    if interest in ("HIGH", "MEDIUM", "LOW"):
        return interest.title()
    upsc_interest = r.get("upsc_interest") or ""
    if upsc_interest:
        return upsc_interest
    objection = (r.get("objection_type") or "").upper()
    objection_map = {
        "NOT_INTERESTED": "Not interested",
        "TIME": "Time / busy",
        "FEES": "Fees concern",
        "CAREER_CONFUSION": "Career confusion",
        "ALREADY_PREPARING": "Already preparing",
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
        follow_up_at=r.get("follow_up_time") or r.get("callback_time") or None,
        language=call.language or None,
        summary=_summarize_call(call),
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
            normalized_phone=None, input_phone=phone, found=False, summary=None, calls=[],
        )

    stmt = (
        select(CallLog)
        .where(CallLog.mobile_number == normalized)
        .order_by(CallLog.started_at.desc().nullslast(), CallLog.vendor_created_at.desc())
    )
    rows = (await db.execute(stmt)).scalars().all()

    if not rows:
        return LookupResult(
            normalized_phone=normalized, input_phone=phone, found=False, summary=None, calls=[],
        )

    calls = [_serialize_call(c) for c in rows]

    total_attempts = sum((c.retry_count + 1) for c in calls)
    connected = sum(1 for c in calls if c.status == "COMPLETED" and c.answered_by == "HUMAN")
    longest_dur = max((c.duration_seconds for c in calls), default=0.0)

    latest_interest = next((c.interest for c in calls if c.interest), None)
    latest_objection = next((c.objection_text for c in calls if c.objection_text), None)
    latest_followup = next((c.follow_up_at for c in calls if c.follow_up_at), None)

    callee_name_row = next((c for c in rows if c.callee_name), None)
    callee_name_str = callee_name_row.callee_name if callee_name_row else None

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
        narrative=_build_narrative(rows),
    )

    return LookupResult(
        normalized_phone=normalized, input_phone=phone, found=True, summary=summary, calls=calls,
    )


@router.get("/recording/{call_id}")
async def get_recording(
    call_id: UUID,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """Streams call recording through this backend so the underlying vendor URL is never exposed."""
    _rate_check(request.client.host if request.client else "unknown")

    call = (await db.execute(select(CallLog).where(CallLog.id == call_id))).scalar_one_or_none()
    if not call or not call.recording_url:
        raise HTTPException(status_code=404, detail="Recording not found")

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
            "Cache-Control": "private, max-age=3600",
            "Content-Disposition": f'inline; filename="call-{call_id}.wav"',
        },
    )
