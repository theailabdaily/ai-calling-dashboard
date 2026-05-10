"""BDA phone-number lookup tool.

Two endpoints:
  GET  /api/lookup?phone=<any-format>      — per-lead summary + per-call history
  GET  /api/lookup/recording/{call_id}     — proxied recording stream

VENDOR/AGENT/CAMPAIGN identifiers are stripped from all responses.
Recording URL is proxied so the underlying GCS/vendor URL never leaks.

The `narrative` on the summary is BD-actionable: it skips low-signal volume
info (e.g. 'picked up 1 of 1') and surfaces lead profile + signals + a
tactical approach recommendation derived from objection/intent/interest.
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
# Rate limit
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
# Phrase mappings — turn raw codes into BDA-friendly English
# ---------------------------------------------------------------------------
_OBJECTION_PHRASES = {
    "TIME": "said timing wasn't right",
    "NOT_INTERESTED": "not interested",
    "ALREADY_PREPARING": "already preparing on their own",
    "FEES": "raised concern about fees",
    "CAREER_CONFUSION": "unsure about career direction",
    "AGE": "raised age-related concern",
    "OTHER": None,
    "Not Covered": None,
    "NOT AVAILABLE": None,
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


# ---------------------------------------------------------------------------
# Per-call summary (description of what happened on a single call)
# ---------------------------------------------------------------------------
def _summarize_call(call: CallLog) -> str | None:
    if call.lifecycle_status != "COMPLETED" or call.answered_by != "HUMAN":
        return None
    r = call.result or {}
    if not r:
        return None

    parts: list[str] = []

    # Profile bits (Schema A or B)
    subject = _clean(r.get("subject"))
    target = _clean(r.get("target")) or _clean(r.get("current_goal"))
    attempt = _clean(r.get("attempt"))
    intent = _clean(r.get("preparation_intent"))
    profile = _clean(r.get("profile"))
    prep_status = _clean(r.get("prep_status"))
    biggest_challenge = _clean(r.get("biggest_challenge"))

    profile_bits: list[str] = []
    if attempt and attempt in _ATTEMPT_PHRASES:
        profile_bits.append(_ATTEMPT_PHRASES[attempt])
    if target:
        profile_bits.append(f"preparing for {target}" + (f" ({subject})" if subject else ""))
    if profile:
        profile_bits.append(profile.lower())
    if intent and intent in _INTENT_PHRASES:
        profile_bits.append(_INTENT_PHRASES[intent])
    elif prep_status:
        profile_bits.append(prep_status.lower())

    if profile_bits:
        parts.append("Lead is " + ", ".join(profile_bits) + ".")

    # Signals on this specific call
    sig_bits: list[str] = []
    interest = _clean(r.get("interest_level")) or _clean(r.get("upsc_interest"))
    engagement = _clean(r.get("engagement_level"))
    if interest:
        sig_bits.append("showed " + _INTEREST_PHRASES.get(interest, interest.lower() + " interest"))
    if engagement and engagement in _ENGAGEMENT_PHRASES:
        sig_bits.append(_ENGAGEMENT_PHRASES[engagement])

    objection_type = _clean(r.get("objection_type"))
    objection_verbatim = _clean(r.get("objections_verbatim"))
    if objection_type:
        phrase = _OBJECTION_PHRASES.get(objection_type)
        if phrase:
            sig_bits.append(phrase)
        elif objection_verbatim:
            quoted = objection_verbatim[:80] + ("…" if len(objection_verbatim) > 80 else "")
            sig_bits.append(f'mentioned: "{quoted}"')

    next_step = _clean(r.get("next_step_interest"))
    if next_step in _NEXT_STEP_PHRASES and _NEXT_STEP_PHRASES[next_step]:
        sig_bits.append(_NEXT_STEP_PHRASES[next_step])
    follow_up = _clean(r.get("follow_up_time")) or _clean(r.get("callback_time"))
    if follow_up:
        sig_bits.append(f"follow-up at {follow_up}")

    if biggest_challenge:
        sig_bits.append(f"main challenge: {biggest_challenge.lower()}")

    if sig_bits:
        parts.append("On this call, " + ", ".join(sig_bits) + ".")

    if not parts and objection_verbatim:
        return f'Lead said: "{objection_verbatim[:120]}"'

    return " ".join(parts) if parts else None


# ---------------------------------------------------------------------------
# BD-action recommendation (the "what should I do" sentence)
# ---------------------------------------------------------------------------
def _recommend_approach(call: CallLog | None) -> str | None:
    """Tactical pitch + timing recommendation derived from latest connected call."""
    if not call or not call.result:
        return None
    r = call.result
    interest = (r.get("interest_level") or "").upper()
    upsc_interest = (r.get("upsc_interest") or "").lower()
    objection = (r.get("objection_type") or "").upper()
    intent = (r.get("preparation_intent") or "").upper()
    next_step = (r.get("next_step_interest") or "").upper()
    follow_up = (r.get("follow_up_time") or r.get("callback_time") or "").strip()
    follow_up_meaningful = bool(follow_up) and follow_up.upper() not in (
        "NA", "N/A", "NOT ANSWERED", "NOT COVERED", "",
    )
    attempt = (r.get("attempt") or "").upper()

    # Map UPSC-style interest into the same buckets as Schema A
    if not interest and upsc_interest:
        if "highly" in upsc_interest:
            interest = "HIGH"
        elif "interested" in upsc_interest:
            interest = "MEDIUM"

    pitch_parts: list[str] = []
    timing_parts: list[str] = []

    # Objection-driven pitch angle (highest signal field)
    if objection == "TIME":
        pitch_parts.append(
            "don't pitch features — lead with time-efficiency: a structured plan "
            "with realistic daily commitment (~2 hrs), PYQ analysis, focused mocks"
        )
    elif objection == "FEES":
        pitch_parts.append(
            "price-sensitive — lead with EMI options, scholarship eligibility, "
            "and ROI vs offline coaching cost"
        )
    elif objection == "ALREADY_PREPARING":
        pitch_parts.append(
            "self-studying — don't position as replacement; sell test series, "
            "mentorship, and doubt-clearing as supplements that fix gaps"
        )
    elif objection == "CAREER_CONFUSION":
        pitch_parts.append(
            "not in buying mindset — connect with a career counsellor first; "
            "a sales pitch will backfire"
        )
    elif objection == "NOT_INTERESTED":
        pitch_parts.append("low signal — move to WhatsApp nurture queue; do not dial again this week")
    elif objection == "AGE":
        pitch_parts.append(
            "age concern — surface success stories of older qualifiers and emphasise "
            "the syllabus is age-agnostic"
        )

    # Intent-based modifier (only if no strong objection picked up the angle)
    if not pitch_parts:
        if intent == "EXPLORING":
            pitch_parts.append(
                "not committed yet — share free content (webinar, sample lectures) "
                "before any direct pitch"
            )
        elif intent == "SERIOUS":
            pitch_parts.append("buyer-mode — direct pitch with specific differentiators is fine")

    # Repeat-aspirant nuance (always relevant when present)
    if attempt == "REPEAT_ATTEMPT":
        pitch_parts.append(
            "knows the exam — emphasise what's different this time "
            "(weak-area analytics, mistake-pattern review)"
        )

    # Timing recommendation
    if interest == "HIGH":
        if follow_up_meaningful:
            timing_parts.append(
                f"hot lead — call at {follow_up} sharp with brochure + payment/scheduling link ready"
            )
        else:
            timing_parts.append(
                "hot lead — call within 24 hrs with brochure + payment/scheduling link ready"
            )
    elif next_step == "CALLBACK" and follow_up_meaningful:
        timing_parts.append(f"call back at {follow_up} as committed")
    elif next_step == "CALLBACK":
        timing_parts.append(
            "asked for a callback but no time committed — call tomorrow morning "
            "before lead drifts"
        )
    elif interest == "LOW":
        timing_parts.append(
            "low priority — WhatsApp drip only; voice call only if engagement signal returns"
        )

    if not pitch_parts and not timing_parts:
        return None

    bits: list[str] = []
    if pitch_parts:
        bits.append("Approach: " + "; ".join(pitch_parts) + ".")
    if timing_parts:
        bits.append("Timing: " + "; ".join(timing_parts) + ".")
    return " ".join(bits)


# ---------------------------------------------------------------------------
# Overall narrative — BD-actionable summary across all calls
# ---------------------------------------------------------------------------
def _build_narrative(calls: list[CallLog]) -> str | None:
    """Build a BD-actionable lead summary.

    Format: [Optional volume note] [Profile] [Signal] [Approach + Timing]
    Volume sentence is skipped unless it carries actionable signal
    (e.g. never picked up despite many attempts).
    """
    if not calls:
        return None

    total = len(calls)
    connected = sum(
        1 for c in calls if c.lifecycle_status == "COMPLETED" and c.answered_by == "HUMAN"
    )
    latest_connected = next(
        (c for c in calls if c.lifecycle_status == "COMPLETED" and c.answered_by == "HUMAN"),
        None,
    )

    parts: list[str] = []

    # ---- Volume note — only when actionable ----
    if connected == 0 and total >= 3:
        parts.append(
            f"Dialled {total} times, no pickups — lead is screening calls or unreachable."
        )
    elif connected == 0:
        parts.append("Has not picked up any call so far.")
    # else: skip — pickup count is already in the stat tiles above the narrative

    # ---- Profile + signal sentences (from latest connected call) ----
    if latest_connected and latest_connected.result:
        r = latest_connected.result
        target = _clean(r.get("target")) or _clean(r.get("current_goal"))
        subject = _clean(r.get("subject"))
        attempt = _clean(r.get("attempt"))
        intent = _clean(r.get("preparation_intent"))
        profile = _clean(r.get("profile"))
        prep_status = _clean(r.get("prep_status"))
        biggest_challenge = _clean(r.get("biggest_challenge"))

        # Profile sentence
        profile_bits: list[str] = []
        if attempt and attempt in _ATTEMPT_PHRASES:
            profile_bits.append(_ATTEMPT_PHRASES[attempt].capitalize())
        elif target:
            profile_bits.append("Aspirant")
        if target and subject:
            profile_bits.append(f"for {target} ({subject})")
        elif target:
            profile_bits.append(f"for {target}")
        if intent and intent in _INTENT_PHRASES:
            profile_bits.append(_INTENT_PHRASES[intent])
        elif prep_status:
            profile_bits.append(prep_status.lower())
        if profile:
            profile_bits.append(profile.lower())

        if profile_bits:
            sentence = " ".join(profile_bits[:2])  # first two go together as core ID
            if len(profile_bits) > 2:
                sentence += ", " + ", ".join(profile_bits[2:])
            parts.append(sentence + ".")

        if biggest_challenge:
            parts.append(f"Main challenge: {biggest_challenge.lower()}.")

        # Signal sentence (what they said on the latest call)
        signal_bits: list[str] = []
        interest = _clean(r.get("interest_level")) or _clean(r.get("upsc_interest"))
        objection_type = _clean(r.get("objection_type"))
        objection_verbatim = _clean(r.get("objections_verbatim"))
        next_step = _clean(r.get("next_step_interest"))
        follow_up = _clean(r.get("follow_up_time")) or _clean(r.get("callback_time"))

        if interest:
            signal_bits.append(
                "showed " + _INTEREST_PHRASES.get(interest, interest.lower() + " interest")
            )
        if objection_type:
            obj_phrase = _OBJECTION_PHRASES.get(objection_type)
            if obj_phrase:
                signal_bits.append(obj_phrase)
            elif objection_verbatim:
                quoted = objection_verbatim[:80] + ("…" if len(objection_verbatim) > 80 else "")
                signal_bits.append(f'said "{quoted}"')

        if next_step == "CALLBACK":
            if follow_up:
                signal_bits.append(f"asked for callback at {follow_up}")
            else:
                signal_bits.append("asked for callback (no time committed)")
        elif next_step == "DEMO":
            signal_bits.append("asked for a demo")
        elif next_step == "ENROL":
            signal_bits.append("ready to enrol")

        if signal_bits:
            parts.append("Last call: " + ", ".join(signal_bits) + ".")

        # ---- Approach (the BD action) ----
        approach = _recommend_approach(latest_connected)
        if approach:
            parts.append(approach)

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
