"""
Standalone sync script. Run from cron or manually:

    python -m scripts.run_sync                    # all vendors
    python -m scripts.run_sync --vendor hunar     # one vendor
"""
import argparse
import asyncio
import logging

from app.jobs.sync import sync_all_vendors, sync_one_vendor

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s — %(message)s")


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--vendor", help="Sync only this vendor slug (e.g. hunar)")
    args = parser.parse_args()

    if args.vendor:
        await sync_one_vendor(args.vendor)
    else:
        await sync_all_vendors()


if __name__ == "__main__":
    asyncio.run(main())
