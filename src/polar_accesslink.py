"""
polar_accesslink.py — Polar AccessLink API v3 client.

Flow per user:
  1. Register user (POST /users) — idempotent, 409 = already registered
  2. Open exercise transaction (POST /users/{uid}/exercise-transactions)
       204 = no new exercises
       201 = transaction created
  3. List exercises in transaction (GET {resource-uri}/exercises)
       404 here = Polar backend race condition; treated as empty list + retry
  4. For each exercise: fetch RR intervals
  5. Commit transaction (PUT) — mandatory; always runs even on error
"""

from __future__ import annotations

import logging
import time
from typing import Any

import requests

logger = logging.getLogger(__name__)

BASE_URL = "https://www.polaraccesslink.com/v3"

# Polar backend sometimes returns 404 on the exercises list immediately after
# opening a transaction (indexing race condition). Retrying usually resolves it.
_EXERCISES_RETRY_ATTEMPTS = 3
_EXERCISES_RETRY_DELAY_S  = 3.0


def _auth_headers(access_token: str, accept: str = "application/json") -> dict:
    return {
        "Authorization": f"Bearer {access_token}",
        "Accept": accept,
        "Content-Type": "application/json",
    }


def _register_user(access_token: str, user_id: int) -> None:
    """Register user with AccessLink. Silently accepts 409 (already registered)."""
    resp = requests.post(
        f"{BASE_URL}/users",
        json={"member-id": str(user_id)},
        headers=_auth_headers(access_token),
        timeout=15,
    )
    if resp.status_code in (200, 201):
        logger.info("User %s registered.", user_id)
    elif resp.status_code == 409:
        logger.debug("User %s already registered (409 — OK).", user_id)
    else:
        logger.warning("Register returned %s for user %s: %s", resp.status_code, user_id, resp.text)
        resp.raise_for_status()


def _fetch_exercise_urls(resource_uri: str, access_token: str) -> list[str]:
    """
    GET {resource_uri}/exercises with retry on 404.

    Polar's backend occasionally returns 404 immediately after a 201 transaction
    is opened — the exercise hasn't been indexed yet. Retrying after a short
    delay reliably resolves this.

    Returns an empty list if the endpoint remains unavailable after all retries.
    """
    url = f"{resource_uri}/exercises"
    for attempt in range(1, _EXERCISES_RETRY_ATTEMPTS + 1):
        resp = requests.get(url, headers=_auth_headers(access_token), timeout=15)

        if resp.status_code == 200:
            urls = resp.json().get("exercises", [])
            logger.info("%d exercise(s) found.", len(urls))
            return urls

        if resp.status_code == 204:
            logger.info("Transaction has no exercises (204).")
            return []

        if resp.status_code == 404:
            if attempt < _EXERCISES_RETRY_ATTEMPTS:
                logger.warning(
                    "Exercises endpoint returned 404 (attempt %d/%d) — "
                    "Polar backend may not have indexed the exercise yet. "
                    "Retrying in %.0fs…",
                    attempt, _EXERCISES_RETRY_ATTEMPTS, _EXERCISES_RETRY_DELAY_S,
                )
                time.sleep(_EXERCISES_RETRY_DELAY_S)
                continue
            else:
                logger.error(
                    "Exercises endpoint returned 404 after %d attempts for %s. "
                    "The session was likely consumed by this transaction without "
                    "being retrievable. Record a new session to try again.",
                    _EXERCISES_RETRY_ATTEMPTS, url,
                )
                return []

        # Any other non-success status
        resp.raise_for_status()

    return []


def get_rr_intervals(access_token: str, user_id: int) -> list[dict[str, Any]]:
    """
    Fetch RR intervals for all new exercises via the AccessLink transaction flow.

    Returns
    -------
    list of dicts, one per exercise with RR data:
        {
            "user_id"     : int,
            "exercise_id" : str,
            "date"        : "YYYY-MM-DD",
            "rr_intervals": [int, ...]   # milliseconds
        }
    Returns [] when there are no new exercises (204) or on recoverable errors.
    """
    # ── 1. Register (idempotent) ──────────────────────────────────────────────
    try:
        _register_user(access_token, user_id)
    except Exception as exc:
        logger.warning("Could not register user %s: %s — continuing.", user_id, exc)

    # ── 2. Open transaction ───────────────────────────────────────────────────
    tx_resp = requests.post(
        f"{BASE_URL}/users/{user_id}/exercise-transactions",
        headers=_auth_headers(access_token),
        timeout=15,
    )

    if tx_resp.status_code == 204:
        logger.info("No new exercises for user %s.", user_id)
        return []

    tx_resp.raise_for_status()
    transaction    = tx_resp.json()
    transaction_id = transaction["transaction-id"]
    resource_uri   = transaction["resource-uri"]
    logger.info("Transaction %s opened for user %s.", transaction_id, user_id)

    results: list[dict[str, Any]] = []

    try:
        # ── 3. List exercises (with retry on 404) ─────────────────────────────
        exercise_urls = _fetch_exercise_urls(resource_uri, access_token)

        # ── 4. Per-exercise: details + RR intervals ───────────────────────────
        for ex_url in exercise_urls:
            exercise_id = ex_url.rstrip("/").split("/")[-1]

            # Exercise metadata (start-time → date)
            ex_resp = requests.get(
                ex_url,
                headers=_auth_headers(access_token),
                timeout=15,
            )
            ex_resp.raise_for_status()
            ex_data = ex_resp.json()
            date    = (ex_data.get("start-time") or "")[:10]   # "YYYY-MM-DD"

            # RR intervals
            rr_resp = requests.get(
                f"{ex_url}/rrIntervals",
                headers=_auth_headers(access_token),
                timeout=15,
            )

            if rr_resp.status_code == 204:
                logger.info("No RR intervals for exercise %s.", exercise_id)
                results.append({
                    "user_id":      user_id,
                    "exercise_id":  exercise_id,
                    "date":         date,
                    "rr_intervals": [],
                })
                continue

            rr_resp.raise_for_status()
            rr_intervals: list[int] = rr_resp.json().get("rr-intervals", [])

            results.append({
                "user_id":      user_id,
                "exercise_id":  exercise_id,
                "date":         date,
                "rr_intervals": rr_intervals,
            })
            logger.info(
                "Exercise %s | date=%s | %d RR intervals.",
                exercise_id, date, len(rr_intervals),
            )

    finally:
        # ── 5. Commit transaction — mandatory, runs even on error ─────────────
        try:
            commit = requests.put(
                resource_uri,
                headers=_auth_headers(access_token),
                timeout=15,
            )
            logger.info("Transaction %s committed → HTTP %s.", transaction_id, commit.status_code)
        except Exception as commit_exc:
            logger.error("Failed to commit transaction %s: %s", transaction_id, commit_exc)

    return results
