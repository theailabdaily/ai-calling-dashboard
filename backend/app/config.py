"""Application configuration loaded from environment variables."""
from functools import lru_cache
from typing import List
from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    # App
    app_name: str = "AI Calling Dashboard"
    environment: str = "development"
    log_level: str = "INFO"

    # DB
    database_url: str = Field(..., description="postgresql+asyncpg://...")

    # Hunar — UGC NET bot (original account)
    hunar_api_key: str | None = None
    hunar_base_url: str = "https://api.voice.hunar.ai/external/v1"

    # Hunar — UPSC bot (separate Hunar org / API key)
    # Syncs under vendor slug "hunar-upsc" so its calls never mix with UGC NET.
    hunar_upsc_api_key: str | None = None
    hunar_upsc_base_url: str = "https://api.voice.hunar.ai/external/v1"

    # SquadStack (placeholder — fill in when integrating)
    squadstack_api_key: str | None = None
    squadstack_base_url: str | None = None

    # Google Sheets
    google_service_account_json: str | None = None  # path to credentials file
    google_sheets_default_id: str | None = None

    # Webhooks — public URL where Hunar can reach us
    public_webhook_base_url: str | None = None
    webhook_shared_secret: str | None = None        # we'll add HMAC verification when Hunar supports it
    cron_shared_secret: str | None = None        # external cron trigger auth (Cloudflare Worker)
    auth_log_secret: str | None = None           # NextAuth → backend audit-log write auth

    # Sync cadence
    sync_calls_interval_minutes: int = 15
    sync_agents_interval_hours: int = 6

    # Dashboard auth (HTTP Basic). Same credentials as frontend.
    dashboard_username: str = "admin"
    dashboard_password: str | None = None

    # Disable APScheduler (e.g. when running cron via GitHub Actions instead)
    disable_internal_scheduler: bool = False

    # CORS
    cors_origins: List[str] = ["http://localhost:3000"]


@lru_cache
def get_settings() -> Settings:
    return Settings()
