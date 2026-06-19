"""
supabase_loader.py — Load HRV session data from Supabase into pandas DataFrames.

Used by notebooks/01_data_ingestion.ipynb as the primary data source
when sessions have been uploaded by the PWA app via BLE recording.

build_master_dataframe() reconstructs a 1Hz HR time series from the raw
beat-to-beat RR intervals so that feature_engineering.py (and notebooks
02 and 03) require zero changes.
"""

from __future__ import annotations

import logging
from functools import lru_cache
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
import yaml

logger = logging.getLogger(__name__)

REPO_ROOT    = Path(__file__).resolve().parent.parent
SECRETS_PATH = REPO_ROOT / "config" / "secrets.yaml"
STUDY_PATH   = REPO_ROOT / "config" / "study.yaml"


def _load_study_start_date() -> str | None:
    """Read study.start_date from config/study.yaml. Returns None if missing."""
    try:
        with open(STUDY_PATH, encoding="utf-8") as f:
            cfg = yaml.safe_load(f)
        return cfg.get("study", {}).get("start_date")
    except FileNotFoundError:
        return None


# Default lower bound for analysis queries — sessions before this date are
# test data collected during setup. Pass start_date=None explicitly to include
# test sessions. The export pipeline always uses start_date=None (exports all).
STUDY_START_DATE: str | None = _load_study_start_date()


# ── Client ────────────────────────────────────────────────────────────────────

def _load_supabase_cfg() -> dict:
    with open(SECRETS_PATH, encoding="utf-8") as f:
        return yaml.safe_load(f).get("supabase", {})


@lru_cache(maxsize=1)
def _get_client():
    """Create and cache a Supabase client using the service_role key."""
    try:
        from supabase import create_client
    except ImportError:
        raise RuntimeError(
            "supabase package not installed. Run: pip install supabase"
        )

    cfg = _load_supabase_cfg()
    url = cfg.get("url", "")
    key = cfg.get("service_key", "")

    if not url or url == "PREENCHER" or not key or key == "PREENCHER":
        raise RuntimeError(
            "Supabase credentials not configured in config/secrets.yaml.\n"
            "Open Supabase Studio → Project Settings → API and copy the values."
        )

    return create_client(url, key)


# ── Public query functions ────────────────────────────────────────────────────

def get_participants() -> list[dict[str, Any]]:
    """Return all participants as a list of dicts."""
    return _get_client().table("participants").select("*").execute().data or []


def get_sessions(
    start_date: str | None = STUDY_START_DATE,
    end_date:   str | None = None,
) -> pd.DataFrame:
    """
    Return sessions as a DataFrame, optionally filtered by date range.

    Parameters
    ----------
    start_date : "YYYY-MM-DD" or None — inclusive lower bound.
                 Defaults to study.start_date from config/study.yaml so that
                 analysis queries exclude pre-study test sessions automatically.
                 Pass start_date=None to retrieve all sessions including tests.
    end_date   : "YYYY-MM-DD" or None — inclusive upper bound

    Returns
    -------
    DataFrame with sessions joined to participant code and demographics.
    Empty DataFrame if no sessions are found.
    """
    client = _get_client()
    q = client.table("sessions").select(
        "*, participants(code, name, birthdate, gender, height_cm, weight_kg)"
    )
    if start_date:
        q = q.gte("session_date", start_date)
    if end_date:
        q = q.lte("session_date", end_date)

    rows = q.order("session_date").order("session_time").execute().data or []
    if not rows:
        return pd.DataFrame()

    for row in rows:
        p = row.pop("participants", {}) or {}
        row["participant_code"] = p.get("code")
        row["height_cm"]        = p.get("height_cm")
        row["weight_kg"]        = p.get("weight_kg")

    df = pd.DataFrame(rows)
    df["session_date"] = pd.to_datetime(df["session_date"]).dt.date
    return df


def get_ecg_samples(session_id: str) -> np.ndarray:
    """
    Return ECG samples for a session as a numpy int32 array of µV values,
    ordered by seq. Returns an empty array if no ECG was recorded.

    A 5-minute session at 130 Hz yields ~39,000 samples.
    Use this for signal-quality checks or waveform visualisation.

    Example
    -------
    ecg_uv = get_ecg_samples(session_id)
    import matplotlib.pyplot as plt
    t = np.arange(len(ecg_uv)) / 130.0  # seconds
    plt.plot(t, ecg_uv); plt.xlabel('s'); plt.ylabel('µV'); plt.show()
    """
    rows = (
        _get_client()
        .table("ecg_samples")
        .select("seq, voltage_uv")
        .eq("session_id", session_id)
        .order("seq")
        .execute()
        .data
        or []
    )
    if not rows:
        return np.array([], dtype=np.int32)

    return np.array([r["voltage_uv"] for r in rows], dtype=np.int32)


def get_rr_raw(session_id: str) -> "pd.DataFrame":
    """
    Devolve os RR intervals de uma sessão com seq e timestamp_ms.
    Se timestamp_ms não foi gravado (NULL), calcula-o por acumulação de rr_ms.
    """
    rows = (
        _get_client()
        .table("rr_intervals")
        .select("seq, rr_ms, timestamp_ms")
        .eq("session_id", session_id)
        .order("seq")
        .execute()
        .data
        or []
    )
    if not rows:
        return pd.DataFrame(columns=["seq", "rr_ms", "timestamp_ms"])
    df = pd.DataFrame(rows)
    if df["timestamp_ms"].isna().all():
        cumsum = np.concatenate([[0], np.cumsum(df["rr_ms"].values[:-1])])
        df["timestamp_ms"] = cumsum.astype("int64")
    return df[["seq", "rr_ms", "timestamp_ms"]]


def get_ecg_raw(session_id: str) -> "pd.DataFrame":
    """
    Devolve as amostras ECG de uma sessão com paginação automática.
    130 Hz × 5 min = ~39 000 rows; o cliente Supabase limita a 1 000 por pedido.
    Se timestamp_ms não foi gravado, infere-o a partir do índice e 130 Hz.
    """
    PAGE   = 1000
    offset = 0
    all_rows: list[dict] = []
    client = _get_client()

    while True:
        batch = (
            client.table("ecg_samples")
            .select("seq, voltage_uv, timestamp_ms")
            .eq("session_id", session_id)
            .order("seq")
            .range(offset, offset + PAGE - 1)
            .execute()
            .data
            or []
        )
        all_rows.extend(batch)
        if len(batch) < PAGE:
            break
        offset += PAGE

    if not all_rows:
        return pd.DataFrame(columns=["seq", "voltage_uv", "timestamp_ms"])

    df = pd.DataFrame(all_rows)
    if df["timestamp_ms"].isna().all():
        df["timestamp_ms"] = (df["seq"] / 130.0 * 1000.0).astype("int64")
    return df[["seq", "voltage_uv", "timestamp_ms"]]


def get_rr_intervals(session_id: str) -> np.ndarray:
    """
    Return RR intervals for a session as a numpy float32 array (ms),
    ordered by seq. Returns an empty array if no data exists.
    """
    rows = (
        _get_client()
        .table("rr_intervals")
        .select("seq, rr_ms")
        .eq("session_id", session_id)
        .order("seq")
        .execute()
        .data
        or []
    )
    if not rows:
        return np.array([], dtype=np.float32)

    return np.array([r["rr_ms"] for r in rows], dtype=np.float32)


# ── Time-series reconstruction ────────────────────────────────────────────────

def _rr_to_1hz(rr_ms: np.ndarray) -> pd.DataFrame:
    """
    Convert beat-to-beat RR intervals to a 1Hz HR time series.

    Algorithm:
      1. Compute beat timestamps: t[i] = Σ rr[0..i-1]  (cumulative, in seconds)
      2. Compute instantaneous HR at each beat: HR = 60000 / rr_ms
      3. Interpolate to a regular 1Hz grid using linear interpolation

    This produces the same column layout as parse_polar_csv() so that
    feature_engineering.py works without any changes.
    """
    if len(rr_ms) < 2:
        return pd.DataFrame()

    # Beat timestamps: first beat is at t=0
    t_beats_s = np.concatenate([[0.0], np.cumsum(rr_ms[:-1]) / 1000.0])
    hr_beats  = 60000.0 / rr_ms

    # 1Hz integer grid from 0 to end of last beat
    n_seconds = int(np.ceil(t_beats_s[-1])) + 1
    t_1hz     = np.arange(n_seconds, dtype=float)

    hr_1hz = np.interp(t_1hz, t_beats_s, hr_beats)

    return pd.DataFrame({
        "Time":   pd.to_timedelta(t_1hz, unit="s"),
        "HR_bpm": np.round(hr_1hz, 1),
        "Time_s": t_1hz.astype(int),
    })


# ── Master DataFrame builder ──────────────────────────────────────────────────

def build_master_dataframe(
    start_date: str | None = STUDY_START_DATE,
    end_date:   str | None = None,
) -> pd.DataFrame:
    """
    Build a master long-format DataFrame from Supabase BLE sessions.

    For each session:
      - Fetches raw RR intervals from Supabase
      - Reconstructs a 1Hz HR time series (interpolated from beat timestamps)
      - Attaches participant ID, date, and metadata columns

    Column format matches parse_polar_csv() output so that feature_engineering.py,
    notebook 02, and notebook 03 work without modification.

    Extra columns added vs. the CSV path:
        hrv_source  : "rr_intervals_ble"
        session_id  : Supabase session UUID (for joining to hrv_master.parquet)

    Parameters
    ----------
    start_date : "YYYY-MM-DD" or None. Defaults to study.start_date from
                 config/study.yaml. Pass None to include pre-study test sessions.
    end_date   : "YYYY-MM-DD" or None

    Returns
    -------
    Concatenated long-format DataFrame. Empty DataFrame if no sessions found.
    """
    sessions = get_sessions(start_date, end_date)
    if sessions.empty:
        logger.info("No sessions found in Supabase.")
        return pd.DataFrame()

    frames: list[pd.DataFrame] = []

    for _, sess in sessions.iterrows():
        session_id = str(sess["id"])
        rr_ms      = get_rr_intervals(session_id)

        if len(rr_ms) < 10:
            logger.warning(
                "Session %s (%s) has only %d RR intervals — skipping.",
                session_id[:8], sess.get("participant_code"), len(rr_ms),
            )
            continue

        ts = _rr_to_1hz(rr_ms)
        if ts.empty:
            continue

        session_date = pd.to_datetime(sess["session_date"])

        ts["User_ID"]    = sess["participant_code"]
        ts["Date"]       = session_date
        ts["Day_of_Week"] = session_date.day_name()
        ts["session_id"] = session_id
        ts["hrv_source"] = "rr_intervals_ble"

        # Session-level metadata (mirrors metadata columns from polar_parser.py)
        ts["height_cm"]  = sess.get("height_cm")
        ts["weight_kg"]  = sess.get("weight_kg")
        ts["duration_meta"] = sess.get("duration_s")

        frames.append(ts)
        logger.info(
            "%-10s | %s | session %s | %d RR → %d rows @1Hz",
            sess["participant_code"],
            sess["session_date"],
            session_id[:8],
            len(rr_ms),
            len(ts),
        )

    if not frames:
        return pd.DataFrame()

    return pd.concat(frames, ignore_index=True)
