"""BDA phone-number lookup tool.

The narrative is structured as two clearly-labeled sections — 'What we know'
(profile + last-call signals) and 'Approach' (strategic angle + subject-aware
talking points + nurture questions). The narrative string uses '**heading**'
markers and '\\n\\n' paragraph separators; the frontend parses these into
proper section headings.
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


# ============================================================================
# Phone normalization
# ============================================================================
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
    if len(digits) != 10 or digits[0] not in "6789":
        return None
    return "+91" + digits


# ============================================================================
# Rate limit
# ============================================================================
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


# ============================================================================
# Helpers
# ============================================================================
def _clean(v: Any) -> str | None:
    if v is None:
        return None
    if not isinstance(v, str):
        return str(v) if v else None
    s = v.strip()
    if not s:
        return None
    if s.lower() in (
        "not answered", "not covered", "not captured", "na", "n/a",
        "not available", "unknown",
    ):
        return None
    return s


def _normalize_subject(s: str | None) -> str | None:
    if not s:
        return s
    if s == s.upper() and len(s) > 4:
        return s.title()
    return s


def _normalize_attempt(r: dict) -> str:
    """Schema A uses 'REPEAT_ATTEMPT' / 'FIRST_ATTEMPT'; Schema B uses
    'Repeat Attempt' / 'First Attempt'. Normalize to the same form."""
    raw = _clean(r.get("attempt")) or _clean(r.get("attempt_number")) or ""
    return raw.upper().replace(" ", "_").replace("-", "_")


# ============================================================================
# Subject playbooks — what to talk about + which questions to ask
# ============================================================================
_SUBJECT_PLAYBOOKS: dict[str, dict[str, Any]] = {
    "ECONOMICS": {
        "talking_points": (
            "Economics splits into Micro, Macro, Indian Economy, Statistics, and "
            "Mathematical Methods — most repeats stall on Math Econ or current-affairs-"
            "heavy Indian Economy. Frame around topic-weighted PYQ analysis: NET "
            "Economics has a high PYQ repeat rate, so weak-area drilling saves more "
            "time than chapter-by-chapter revision. Tie to our test series (which "
            "breaks down performance by unit) and the Indian Economy module which "
            "ships weekly current-affairs updates so the lead doesn't have to track "
            "NSSO/RBI separately."
        ),
        "questions": [
            "Which area scares you most — Math Econ, or Indian Economy current affairs?",
            "Have you done a topic-weighted PYQ analysis for the last 5 NET papers?",
            "How are you handling Indian Economy current affairs every month?",
        ],
    },
    "HISTORY": {
        "talking_points": (
            "NET History covers Ancient, Medieval, Modern Indian, World, and "
            "Historiography — most repeats lose marks on Historiography (theoretical) "
            "and source-based questions in Paper 2. Frame around theme-wise mastery "
            "instead of chronology: themes like 'agrarian relations' or 'social "
            "reform' cut across periods and produce more answers per hour studied. "
            "Our History course has dedicated historiography and source-question modules."
        ),
        "questions": [
            "Which area takes you longest — Modern Indian or Historiography?",
            "Are you confident about source-based questions in Paper 2?",
            "Are you organising prep by chronology, or by theme?",
        ],
    },
    "SOCIOLOGY": {
        "talking_points": (
            "NET Sociology covers Sociological Theory (Marx, Weber, Durkheim), "
            "Research Methods, Indian Society, Stratification, and Social Change. "
            "Most repeats stall on theory application — knowing Weber isn't enough; "
            "applying him to a contemporary Indian case is the actual exam. Our "
            "Sociology course includes concept-application drills and weekly Indian "
            "Society current-affairs updates."
        ),
        "questions": [
            "Which theorist's framework do you find hardest to apply?",
            "How are you tracking recent NSSO / Census data for Indian Society questions?",
            "What's your weakest area — theory or application?",
        ],
    },
    "POLITICAL SCIENCE": {
        "talking_points": (
            "NET Pol Sc covers Political Theory, Indian Govt & Politics, Comparative "
            "Politics, IR, and Public Administration. The classic trap is treating "
            "theory as memorisation — examiners want application to current cases. "
            "Frame around case-study answer-writing. Our Pol Sc course has dedicated "
            "essay frameworks and current-affairs-tagged answer banks."
        ),
        "questions": [
            "Which area do you find hardest — Theory or Comparative Politics?",
            "How regular is your answer-writing practice for Paper 2?",
            "Are you confident on the IR section's recent-events component?",
        ],
    },
    "COMMERCE": {
        "talking_points": (
            "NET Commerce spans Accounting, Business Finance, Marketing, HR, "
            "International Business, and Statistics. The high-leverage areas are "
            "the calculation-heavy units (Accounting + Finance) where most marks "
            "are lost on careless errors, not concept gaps. Tie to our targeted "
            "drills on PYQ-style numericals."
        ),
        "questions": [
            "Where are you losing more marks — concepts or calculation errors?",
            "Have you mapped PYQs by topic weightage for the last 5 papers?",
            "How confident are you on the International Business + IFRS section?",
        ],
    },
}

_UPSC_PLAYBOOK = {
    "talking_points": (
        "UPSC prep splits into Prelims (GS + CSAT), Mains (4 GS papers + Optional + "
        "Essay), and Personality Test. Most aspirants under-invest in answer-writing "
        "and CSAT — the two highest-leverage areas after the syllabus is once covered. "
        "Frame around our integrated programme: daily answer-writing with feedback, "
        "weekly CSAT mocks, and current-affairs that's syllabus-mapped (not a news dump)."
    ),
    "questions": [
        "Are you investing more time on Prelims or Mains right now?",
        "How regular is your answer-writing practice — daily, weekly, or only test-day?",
        "Have you picked your optional yet? How confident are you on it?",
    ],
}

_DEFAULT_PLAYBOOK = {
    "talking_points": (
        "Repeats usually have weak-area gaps from their last attempt rather than "
        "total knowledge gaps. Frame around diagnostic-first prep: a topic-weighted "
        "weak-area test reveals where most mark loss happens. Tie to whatever module "
        "is closest to their subject in our catalog."
    ),
    "questions": [
        "Which topic do you score lowest on in mock tests?",
        "Have you looked at PYQ trends for the last 3-5 cycles?",
        "What's your biggest time-leak — concept gaps, revision, or answer-writing?",
    ],
}


def _pick_playbook(subject: str | None, target: str | None) -> dict[str, Any]:
    """Subject-keyed first; UPSC target fallback; generic default last."""
    if subject:
        key = subject.upper().strip()
        if key in _SUBJECT_PLAYBOOKS:
            return _SUBJECT_PLAYBOOKS[key]
    if target:
        tkey = target.upper().strip()
        if "UPSC" in tkey or tkey == "CSE":
            return _UPSC_PLAYBOOK
    return _DEFAULT_PLAYBOOK


# ============================================================================
# Per-call summary
# ============================================================================
_INTEREST_PHRASES = {
    "HIGH": "high interest", "MEDIUM": "moderate interest", "LOW": "low interest",
    "Highly Interested": "high interest", "Interested": "interest",
}

_OBJECTION_INLINE = {
    "TIME": "said timing wasn't right",
    "NOT_INTERESTED": "not interested",
    "ALREADY_PREPARING": "already self-studying",
    "FEES": "raised fees concern",
    "CAREER_CONFUSION": "unsure about career",
    "AGE": "raised age concern",
}


def _summarize_call(call: CallLog) -> str | None:
    if call.lifecycle_status != "COMPLETED" or call.answered_by != "HUMAN":
        return None
    r = call.result or {}
    if not r:
        return None

    target = _clean(r.get("target")) or _clean(r.get("current_goal"))
    subject = _normalize_subject(_clean(r.get("subject")))
    attempt = _normalize_attempt(r)
    intent = (_clean(r.get("preparation_intent")) or "").upper()

    profile_parts: list[str] = []
    if attempt == "REPEAT_ATTEMPT":
        profile_parts.append("Repeat")
    elif attempt == "FIRST_ATTEMPT":
        profile_parts.append("First-time")
    if target and subject:
        profile_parts.append(f"{target} ({subject})")
    elif target:
        profile_parts.append(target)
    if profile_parts:
        profile_parts.append("aspirant")

    intent_phrase = None
    if intent == "EXPLORING":
        intent_phrase = "still exploring"
    elif intent == "SERIOUS":
        intent_phrase = "preparing seriously"

    profile_text = " ".join(profile_parts) if profile_parts else None
    if profile_text and intent_phrase:
        profile_text = f"{profile_text}, {intent_phrase}"
    elif intent_phrase and not profile_text:
        profile_text = intent_phrase

    interest = _clean(r.get("interest_level")) or _clean(r.get("upsc_interest"))
    objection_type = (r.get("objection_type") or "").upper()
    objection_verbatim = _clean(r.get("objections_verbatim"))
    next_step = (r.get("next_step_interest") or "").upper()
    follow_up = _clean(r.get("follow_up_time")) or _clean(r.get("callback_time"))

    sig: list[str] = []
    if interest:
        sig.append(f"showed {_INTEREST_PHRASES.get(interest, interest.lower() + ' interest')}")
    if objection_type in _OBJECTION_INLINE:
        sig.append(_OBJECTION_INLINE[objection_type])
    elif objection_verbatim and objection_type not in ("NOT COVERED", "NOT AVAILABLE", ""):
        quoted = objection_verbatim[:80] + ("…" if len(objection_verbatim) > 80 else "")
        sig.append(f'said "{quoted}"')
    if next_step == "CALLBACK":
        sig.append(f"asked for callback at {follow_up}" if follow_up else "asked for a callback")
    elif next_step == "DEMO":
        sig.append("asked for a demo")
    elif next_step == "ENROL":
        sig.append("ready to enrol")

    parts: list[str] = []
    if profile_text:
        parts.append(profile_text[0].upper() + profile_text[1:] + ".")
    if sig:
        parts.append("On call: " + ", ".join(sig) + ".")

    if not parts and objection_verbatim:
        return f'Said: "{objection_verbatim[:120]}"'

    return " ".join(parts) if parts else None


# ============================================================================
# Narrative builders
# ============================================================================
def _profile_paragraph(r: dict) -> str | None:
    target = _clean(r.get("target")) or _clean(r.get("current_goal"))
    subject = _normalize_subject(_clean(r.get("subject")))
    attempt = _normalize_attempt(r)
    intent = (_clean(r.get("preparation_intent")) or "").upper()
    profile = _clean(r.get("profile"))
    target_year = _clean(r.get("target_year"))
    biggest_challenge = _clean(r.get("biggest_challenge"))

    if not target and not profile:
        return None

    head: list[str] = []
    if attempt == "REPEAT_ATTEMPT":
        head.append("Repeat")
    elif attempt == "FIRST_ATTEMPT":
        head.append("First-time")

    if target and subject:
        head.append(f"{target} ({subject})")
    elif target:
        head.append(target)

    if head:
        head.append("aspirant")
    base = " ".join(head)

    extras: list[str] = []
    if profile:
        extras.append(profile.lower())
    if target_year:
        extras.append(f"target {target_year}")
    if intent == "EXPLORING":
        extras.append("still in exploring mode")
    elif intent == "SERIOUS":
        extras.append("serious about preparation")

    if base and extras:
        sentence = f"{base}, " + ", ".join(extras) + "."
    elif base:
        sentence = base + "."
    elif extras:
        joined = ", ".join(extras)
        sentence = joined[0].upper() + joined[1:] + "."
    else:
        return None

    if biggest_challenge:
        sentence += f" Main challenge is {biggest_challenge.lower()}."

    return sentence


def _status_paragraph(r: dict) -> str | None:
    interest = _clean(r.get("interest_level")) or _clean(r.get("upsc_interest"))
    objection_type = (r.get("objection_type") or "").upper()
    objection_verbatim = _clean(r.get("objections_verbatim"))
    next_step = (r.get("next_step_interest") or "").upper()
    follow_up = _clean(r.get("follow_up_time")) or _clean(r.get("callback_time"))

    bits: list[str] = []
    if interest:
        i = interest.lower()
        if interest.upper() == "HIGH" or "highly" in i:
            bits.append("Showed strong interest")
        elif interest.upper() == "MEDIUM" or i == "interested":
            bits.append("Showed moderate interest")
        elif interest.upper() == "LOW":
            bits.append("Low interest signal")

    obj_map = {
        "TIME": "said the time commitment is too high",
        "FEES": "raised concerns about fees",
        "ALREADY_PREPARING": "already self-studying",
        "NOT_INTERESTED": "wasn't interested in our offering",
        "CAREER_CONFUSION": "expressed confusion about career direction",
        "AGE": "raised an age-related concern",
    }
    if objection_type in obj_map:
        bits.append(obj_map[objection_type])
    elif objection_verbatim and objection_type not in ("NOT COVERED", "NOT AVAILABLE", ""):
        quoted = objection_verbatim[:90] + ("…" if len(objection_verbatim) > 90 else "")
        bits.append(f'said "{quoted}"')

    if next_step == "CALLBACK":
        bits.append(
            f"asked for a callback at {follow_up}" if follow_up
            else "asked for a callback without locking a slot"
        )
    elif next_step == "DEMO":
        bits.append("wants a demo")
    elif next_step == "ENROL":
        bits.append("ready to enrol")

    if not bits:
        return None
    if len(bits) == 1:
        return bits[0][0].upper() + bits[0][1:] + "."
    if len(bits) == 2:
        return f"{bits[0][0].upper() + bits[0][1:]}, {bits[1]}."
    first = bits[0][0].upper() + bits[0][1:]
    middle = ", ".join(bits[1:-1])
    return f"{first}, {middle}, and {bits[-1]}."


def _strategic_angle(r: dict) -> str | None:
    interest = (r.get("interest_level") or "").upper()
    upsc_interest = (r.get("upsc_interest") or "").lower()
    objection = (r.get("objection_type") or "").upper()
    intent = (r.get("preparation_intent") or "").upper()
    attempt = _normalize_attempt(r)

    if not interest:
        if "highly" in upsc_interest:
            interest = "HIGH"
        elif "interested" in upsc_interest:
            interest = "MEDIUM"

    if objection == "TIME":
        if attempt == "REPEAT_ATTEMPT":
            return (
                "This is a sceptical repeat aspirant — pushing hard will backfire. "
                "Open with a realistic 2-hr/day plan and weak-area analytics that "
                "show what's different this time."
            )
        return (
            "The lead's worried about the time commitment. Lead with a structured "
            "plan and PYQ-driven shortcuts — frame everything around output per hour, "
            "not features."
        )
    if objection == "FEES":
        return (
            "Price-sensitive. Don't open with the sticker. Lead with EMI options and "
            "scholarship eligibility, and frame ROI against offline coaching cost."
        )
    if objection == "ALREADY_PREPARING":
        return (
            "The lead's already self-studying — don't position our course as a "
            "replacement. Pitch test series, mentorship, or doubt-clearing as "
            "supplements that fix gaps in their current prep."
        )
    if objection == "CAREER_CONFUSION":
        return (
            "Not in a buying mindset yet. Connect with a counsellor first — "
            "selling now will backfire."
        )
    if objection == "NOT_INTERESTED":
        return "Low signal lead. Move to WhatsApp nurture and don't dial again this week."
    if objection == "AGE":
        return (
            "Surface success stories of older qualifiers — the syllabus is age-agnostic "
            "and selection rates by age band are reassuring."
        )
    if intent == "EXPLORING":
        return (
            "Not committed yet. Send free content (sample lectures, webinar) before "
            "any direct pitch."
        )
    if intent == "SERIOUS" and interest == "HIGH":
        return (
            "Buyer-mode. Direct pitch is fine — lead with the most specific differentiator "
            "(live doubt-clearing, mentor calls)."
        )
    return None


def _approach_paragraphs(r: dict) -> list[str]:
    """Returns a list of paragraphs for the Approach section."""
    objection = (r.get("objection_type") or "").upper()
    subject = _clean(r.get("subject"))
    target = _clean(r.get("target")) or _clean(r.get("current_goal"))

    paragraphs: list[str] = []

    angle = _strategic_angle(r)
    if angle:
        paragraphs.append(angle)

    # Skip subject content + questions for "not interested" — no point
    if objection != "NOT_INTERESTED":
        playbook = _pick_playbook(subject, target)
        tp = playbook.get("talking_points")
        if tp:
            paragraphs.append("Talking points: " + tp)
        questions = playbook.get("questions") or []
        if questions:
            q_block = "Questions to open with:\n" + "\n".join(f"• {q}" for q in questions)
            paragraphs.append(q_block)

    return paragraphs


def _build_narrative(calls: list[CallLog]) -> str | None:
    """Build the BD-actionable narrative.

    Output is a single string with '**Heading**' markers and '\\n\\n'
    paragraph separators. Frontend splits and renders headings as section titles.
    """
    if not calls:
        return None

    total = len(calls)
    connected = sum(
        1 for c in calls
        if c.lifecycle_status == "COMPLETED" and c.answered_by == "HUMAN"
    )
    latest_connected = next(
        (c for c in calls if c.lifecycle_status == "COMPLETED" and c.answered_by == "HUMAN"),
        None,
    )

    paragraphs: list[str] = []

    # Volume note (only when there's no connected call to derive richer signal from)
    if connected == 0 and total >= 3:
        paragraphs.append("**What we know**")
        paragraphs.append(f"Dialled {total} times — never picked up.")
        paragraphs.append("**Approach**")
        paragraphs.append(
            "Lead is screening or unreachable. Switch channels: send a WhatsApp "
            "template with a short voice note in their language, then try one more "
            "dial 5 days later. If still no response, write off."
        )
        return "\n\n".join(paragraphs)
    if connected == 0:
        paragraphs.append("Hasn't picked up any call yet. Try again at a different hour.")
        return "\n\n".join(paragraphs)

    if latest_connected and latest_connected.result:
        r = latest_connected.result

        # ---- What we know ----
        whats_known: list[str] = []
        p = _profile_paragraph(r)
        if p:
            whats_known.append(p)
        s = _status_paragraph(r)
        if s:
            whats_known.append(s)

        if whats_known:
            paragraphs.append("**What we know**")
            paragraphs.extend(whats_known)

        # ---- Approach ----
        approach_paras = _approach_paragraphs(r)
        if approach_paras:
            paragraphs.append("**Approach**")
            paragraphs.extend(approach_paras)

    return "\n\n".join(paragraphs) if paragraphs else None


# ============================================================================
# Build response objects
# ============================================================================
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


# ============================================================================
# Routes
# ============================================================================
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
