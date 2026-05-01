"""
Google Sheets → leads ingestion.

Auth: Service Account JSON key, granted Viewer access to the sheet.
Sheet shape (header row required):
    name | mobile_number | email | <any extra cols become custom_data>

The service is intentionally tolerant — missing fields don't blow up the row.
"""
from __future__ import annotations

import logging
from typing import Any

import gspread
from google.oauth2.service_account import Credentials
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.models import Lead

logger = logging.getLogger(__name__)

SCOPES = ["https://www.googleapis.com/auth/spreadsheets.readonly"]


def _normalize_phone(raw: str) -> str:
    raw = (raw or "").strip().replace(" ", "").replace("-", "")
    if not raw:
        return ""
    if raw.startswith("+"):
        return raw
    # Indian default — adjust if you go international
    if len(raw) == 10:
        return f"+91{raw}"
    if raw.startswith("91") and len(raw) == 12:
        return f"+{raw}"
    return raw


async def import_sheet(db: AsyncSession, sheet_id: str, worksheet_name: str | None = None) -> dict[str, Any]:
    s = get_settings()
    if not s.google_service_account_json:
        raise RuntimeError("GOOGLE_SERVICE_ACCOUNT_JSON not configured")

    creds = Credentials.from_service_account_file(s.google_service_account_json, scopes=SCOPES)
    gc = gspread.authorize(creds)
    sheet = gc.open_by_key(sheet_id)
    ws = sheet.worksheet(worksheet_name) if worksheet_name else sheet.sheet1

    rows = ws.get_all_records()  # list[dict] using header row as keys
    inserted = 0
    skipped = 0

    for idx, row in enumerate(rows, start=2):  # +2 because header is row 1, data starts at row 2
        name = (row.get("name") or row.get("Name") or "").strip()
        phone_raw = str(row.get("mobile_number") or row.get("phone") or row.get("Phone") or "").strip()
        phone = _normalize_phone(phone_raw)
        if not name or not phone:
            skipped += 1
            continue

        email = (row.get("email") or row.get("Email") or "").strip() or None
        # Whatever else the user put in the sheet -> custom_data
        consumed = {"name", "Name", "mobile_number", "phone", "Phone", "email", "Email"}
        custom_data = {k: v for k, v in row.items() if k not in consumed and v not in (None, "")}

        stmt = pg_insert(Lead).values(
            source="google_sheets",
            source_ref=f"sheet:{sheet_id}:row:{idx}",
            name=name,
            mobile_number=phone,
            email=email,
            custom_data=custom_data,
        ).on_conflict_do_nothing()
        await db.execute(stmt)
        inserted += 1

    await db.commit()
    return {"sheet_id": sheet_id, "rows_seen": len(rows), "rows_inserted": inserted, "rows_skipped": skipped}
