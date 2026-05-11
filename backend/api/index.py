"""Vercel serverless entrypoint. Imports the FastAPI app."""
import sys
from pathlib import Path

# Ensure backend/ is on sys.path so `from app.main import app` works.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.main import app  # noqa: E402  pylint: disable=wrong-import-position
