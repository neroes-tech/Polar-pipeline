"""
seed_participants.py — Insert/update participants in Supabase from config/participants.yaml.

Uses the service_role key (bypasses RLS) so it can write to participants.
Safe to re-run: upserts on the `code` column, never duplicates.

Usage:
    python scripts/seed_participants.py

Requirements:
    pip install supabase pyyaml
"""

from __future__ import annotations

import sys
from pathlib import Path

import yaml

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))


def _load_config() -> tuple[dict, list[dict]]:
    secrets_path = REPO_ROOT / "config" / "secrets.yaml"
    participants_path = REPO_ROOT / "config" / "participants.yaml"

    if not secrets_path.exists():
        sys.exit(
            f"ERROR: {secrets_path} not found.\n"
            "Fill in config/secrets.yaml with your Supabase URL and service_key."
        )

    with open(secrets_path, encoding="utf-8") as f:
        secrets = yaml.safe_load(f)

    sb = secrets.get("supabase", {})
    url = sb.get("url", "")
    key = sb.get("service_key", "")

    if not url or url == "PREENCHER" or not key or key == "PREENCHER":
        sys.exit(
            "ERROR: Supabase URL or service_key not configured in config/secrets.yaml.\n"
            "Open Supabase Studio → Project Settings → API and copy the values."
        )

    with open(participants_path, encoding="utf-8") as f:
        cfg = yaml.safe_load(f)

    return (url, key), cfg.get("participants", [])


def _map_participant(p: dict) -> dict:
    """Map participants.yaml fields → Supabase participants table columns."""
    gender_map = {"M": "M", "F": "F", "m": "M", "f": "F"}

    return {
        "code":       p.get("id") or p.get("code"),
        "name":       p.get("name"),
        "birthdate":  p.get("birthdate"),         # "YYYY-MM-DD" or null
        "gender":     gender_map.get(str(p.get("gender") or p.get("sex") or ""), None),
        "height_cm":  p.get("height_cm"),
        "weight_kg":  p.get("weight_kg"),
        "device_id":  p.get("device_id"),         # H10 serial, e.g. "B5FC3820"
    }


def main() -> None:
    try:
        from supabase import create_client
    except ImportError:
        sys.exit("ERROR: supabase package not installed.\nRun: pip install supabase")

    (url, key), participants = _load_config()

    if not participants:
        sys.exit("ERROR: No participants found in config/participants.yaml.")

    client = create_client(url, key)
    print(f"Connected to Supabase: {url}")
    print(f"Seeding {len(participants)} participant(s)...\n")

    for p in participants:
        row = _map_participant(p)
        code = row["code"]

        if not code:
            print(f"  SKIP — participant has no id/code: {p}")
            continue

        # Upsert: insert or update based on unique `code` column
        result = (
            client.table("participants")
            .upsert(row, on_conflict="code")
            .execute()
        )

        if result.data:
            action = "UPDATED" if len(result.data) == 1 else "INSERTED"
            rec = result.data[0]
            print(
                f"  {action}: {code} "
                f"(uuid={rec['id']}, device_id={rec.get('device_id') or 'not set'})"
            )
        else:
            print(f"  WARNING: No response data for {code} — check Supabase logs.")

    print(f"\nDone. {len(participants)} band(s) upserted.")
    print("Verify in Supabase Studio → Table Editor → participants.")


if __name__ == "__main__":
    main()
