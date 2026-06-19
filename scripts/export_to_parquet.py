"""
export_to_parquet.py — Full Supabase snapshot to timestamped local parquet files.

Creates backups in data/backup/ with date in the filename so multiple
snapshots can coexist without overwriting each other.

Output files:
    data/backup/participants_YYYY-MM-DD.parquet
    data/backup/sessions_YYYY-MM-DD.parquet
    data/backup/rr_intervals_YYYY-MM-DD.parquet

Usage:
    python scripts/export_to_parquet.py

Requires:
    pip install supabase pyarrow
    config/secrets.yaml must have supabase.service_key configured
"""

from __future__ import annotations

import sys
from datetime import datetime
from pathlib import Path

import pandas as pd

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))


def main() -> None:
    try:
        from src.supabase_loader import _get_client
    except RuntimeError as exc:
        sys.exit(f"ERROR: {exc}")

    client = _get_client()
    today  = datetime.now().strftime("%Y-%m-%d")

    backup_dir = REPO_ROOT / "data" / "backup"
    backup_dir.mkdir(parents=True, exist_ok=True)

    exports = {
        "participants": (
            client.table("participants")
            .select("*")
            .order("created_at")
            .execute()
        ),
        "sessions": (
            client.table("sessions")
            .select("*")
            .order("session_date")
            .order("session_time")
            .execute()
        ),
        "rr_intervals": (
            client.table("rr_intervals")
            .select("*")
            .order("session_id")
            .order("seq")
            .execute()
        ),
    }

    print(f"Supabase snapshot → data/backup/ ({today})\n")

    total_rr = 0
    for table_name, result in exports.items():
        rows = result.data or []
        df   = pd.DataFrame(rows)
        path = backup_dir / f"{table_name}_{today}.parquet"
        df.to_parquet(path, index=False, engine="pyarrow")

        rel = path.relative_to(REPO_ROOT)
        print(f"  {table_name:<16} {len(df):>6,} rows  →  {rel}")

        if table_name == "rr_intervals":
            total_rr = len(df)

    print()
    if total_rr > 0:
        approx_sessions = total_rr // 300
        print(f"  ~{approx_sessions} sessions worth of RR intervals ({total_rr:,} beats)")
    else:
        print("  No RR intervals yet — run the PWA app to collect data.")

    print("\nDone. To restore, read the parquet files with pd.read_parquet().")


if __name__ == "__main__":
    main()
