#!/usr/bin/env python3
"""Keep the workflow cron in step with config.json.

GitHub Actions cannot read a schedule out of a file, so the interval would
normally live in two places and drift. config.json stays the single source of
truth and this script writes the cron line for it.

    python scripts/schedule.py            # check, exit 1 on drift
    python scripts/schedule.py --write    # rewrite the workflow cron
"""

from __future__ import annotations

import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WORKFLOW = os.path.join(ROOT, ".github", "workflows", "collect.yml")


def cron_for(minutes: int) -> str:
    if minutes < 5:
        raise SystemExit("GitHub Actions will not run a scheduled workflow faster than "
                         "every 5 minutes, and in practice not faster than ~10.")
    if minutes < 60:
        if 60 % minutes:
            raise SystemExit(f"{minutes} min does not divide an hour; pick 5, 6, 10, 12, 15, 20 or 30.")
        return f"*/{minutes} * * * *"
    hours = minutes // 60
    if minutes % 60 or 24 % hours:
        raise SystemExit(f"{minutes} min is not a whole number of hours dividing a day.")
    return f"0 */{hours} * * *" if hours > 1 else "0 * * * *"


def main() -> int:
    with open(os.path.join(ROOT, "config.json"), "r", encoding="utf-8") as fh:
        minutes = json.load(fh)["collect_interval_minutes"]
    want = cron_for(minutes)

    with open(WORKFLOW, "r", encoding="utf-8") as fh:
        text = fh.read()
    found = re.search(r"cron:\s*'([^']+)'", text)
    if not found:
        raise SystemExit("no cron line in the workflow")

    if found.group(1) == want:
        print(f"in step: {minutes} min -> cron '{want}'")
        return 0
    if "--write" not in sys.argv:
        print(f"DRIFT: config says {minutes} min -> '{want}', workflow says '{found.group(1)}'")
        print("run: python scripts/schedule.py --write")
        return 1
    with open(WORKFLOW, "w", encoding="utf-8") as fh:
        fh.write(text[:found.start(1)] + want + text[found.end(1):])
    print(f"written: {minutes} min -> cron '{want}'")
    return 0


if __name__ == "__main__":
    sys.exit(main())
