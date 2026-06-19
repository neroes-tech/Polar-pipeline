"""
create_auth_users.py — Create Supabase Auth accounts for all Neroes HRV bands.

Creates one account per participant band (HM01–HM22) and links each account to
its participant row via auth_user_id.

  Email format   : polarNN@healme.pt    (NN = zero-padded number from HM code)
  Default password: HMshift10.polar     (change via --password)
  Auth method    : email + password (email confirmation bypassed via service_role)

PRE-REQUISITES:
  1. Disable email confirmation in Supabase Dashboard:
       Authentication → Providers → Email → "Confirm email" → OFF
  2. Run migrate_auth.sql in the Supabase SQL Editor FIRST (adds auth_user_id column).
  3. pip install supabase (supabase-py v2+)

USAGE:
  python scripts/create_auth_users.py
  python scripts/create_auth_users.py --password "NewP@ss123"
  python scripts/create_auth_users.py --dry-run     # shows what would be created

NOTES:
  - Running a second time is SAFE: existing accounts are detected and skipped.
  - service_role key is used (bypasses RLS, never goes in the app).
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

import yaml

REPO_ROOT    = Path(__file__).resolve().parent.parent
SECRETS_PATH = REPO_ROOT / "config" / "secrets.yaml"
DEFAULT_PASSWORD = "HMshift10.polar"
EMAIL_DOMAIN     = "healme.pt"


def _load_cfg() -> dict:
    with open(SECRETS_PATH, encoding="utf-8") as f:
        return yaml.safe_load(f).get("supabase", {})


def _get_client():
    try:
        from supabase import create_client
    except ImportError:
        sys.exit("ERROR: supabase not installed. Run: pip install supabase")

    cfg = _load_cfg()
    url = cfg.get("url", "")
    key = cfg.get("service_key", "")
    if not url or url == "PREENCHER" or not key or key == "PREENCHER":
        sys.exit(
            "ERROR: Supabase credentials not in config/secrets.yaml.\n"
            "Set supabase.url and supabase.service_key."
        )
    return create_client(url, key)


def code_to_email(code: str) -> str:
    """'HM01' → 'polar01@healme.pt'"""
    m = re.search(r"\d+$", code)
    if not m:
        raise ValueError(f"Cannot parse number from participant code '{code}'")
    return f"polar{int(m.group()):02d}@{EMAIL_DOMAIN}"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--password", default=DEFAULT_PASSWORD, help="Password for all accounts")
    parser.add_argument("--dry-run", action="store_true", help="Print what would be done without making changes")
    args = parser.parse_args()

    sb = _get_client()

    # Fetch all participants
    result = sb.table("participants").select("id, code, auth_user_id").order("code").execute()
    participants = result.data or []
    if not participants:
        sys.exit("ERROR: No participants found. Run seed_participants.py first.")

    print(f"\nNeroes HRV — Create Auth Accounts ({len(participants)} bands)\n")
    print(f"  Email format : polarNN@{EMAIL_DOMAIN}")
    print(f"  Password     : {'(provided via --password)' if args.password != DEFAULT_PASSWORD else DEFAULT_PASSWORD}")
    print(f"  Dry-run      : {args.dry_run}\n")
    print(f"{'Code':<8} {'Email':<30} {'Status'}")
    print("-" * 60)

    created = 0
    skipped = 0
    errors  = 0

    for p in participants:
        code   = p["code"]
        email  = code_to_email(code)
        linked = p.get("auth_user_id") is not None

        if linked and not args.dry_run:
            print(f"  {code:<6}  {email:<30}  ✓ already linked")
            skipped += 1
            continue

        if args.dry_run:
            print(f"  {code:<6}  {email:<30}  [dry-run: would create & link]")
            continue

        # Create auth user (email_confirm=True bypasses email verification)
        try:
            resp = sb.auth.admin.create_user({
                "email":         email,
                "password":      args.password,
                "email_confirm": True,
            })
            user_id = resp.user.id
        except Exception as e:
            err_str = str(e).lower()
            if "already been registered" in err_str or "already exists" in err_str:
                # User exists — find their ID and link
                try:
                    users_resp = sb.auth.admin.list_users()
                    existing   = next((u for u in users_resp if u.email == email), None)
                    if not existing:
                        print(f"  {code:<6}  {email:<30}  ✗ exists but ID not found — link manually")
                        errors += 1
                        continue
                    user_id = existing.id
                    print(f"  {code:<6}  {email:<30}  ~ user exists, linking...")
                except Exception as e2:
                    print(f"  {code:<6}  {email:<30}  ✗ ERROR: {e2}")
                    errors += 1
                    continue
            else:
                print(f"  {code:<6}  {email:<30}  ✗ ERROR: {e}")
                errors += 1
                continue

        # Link auth user to participant row
        try:
            sb.table("participants").update({"auth_user_id": str(user_id)}).eq("code", code).execute()
            print(f"  {code:<6}  {email:<30}  ✓ created & linked  ({user_id[:8]}...)")
            created += 1
        except Exception as e:
            print(f"  {code:<6}  {email:<30}  ✓ created but link FAILED: {e}")
            errors += 1

    print("-" * 60)
    if args.dry_run:
        print(f"\n  Dry-run complete. {len(participants)} accounts would be processed.")
    else:
        print(f"\n  Created: {created}  |  Skipped (already exist): {skipped}  |  Errors: {errors}")
        if errors:
            print("  Fix errors above and re-run — it is safe to run multiple times.")
        else:
            print("\n  All done. Users can now sign in with their polar<NN>@healme.pt account.")

    print()


if __name__ == "__main__":
    main()
