"""
polar_parser.py — Parse exported Polar Flow CSV files.

CSV layout (Polar Flow export, confirmed from real device data):
  Row 0  : metadata keys   (Name, Sport, Date, Start time, Duration, …)
  Row 1  : metadata values (Bruno Sousa, OTHER_OUTDOOR, 2026-06-07, …)
  Row 2  : time-series header (Sample rate, Time, HR (bpm), …)
  Row 3+ : time-series at 1 Hz
"""

from __future__ import annotations

import logging
import re
from pathlib import Path
from typing import Any

import pandas as pd

logger = logging.getLogger(__name__)

# ── time-series column rename map ─────────────────────────────────────────────
_COL_MAP = {
    # English labels (real Polar Flow export)
    "time": "Time",
    "hr (bpm)": "HR_bpm",
    "speed (km/h)": "Speed_kmh",
    "pace (min/km)": "Pace_minkm",
    "cadence": "Cadence_rpm",
    "altitude (m)": "Altitude_m",
    "stride length (m)": "Stride_m",
    "distances (m)": "Distance_m",
    "distance (m)": "Distance_m",
    "temperatures (c)": "Temp_C",
    "temperature (c)": "Temp_C",
    "temperature (°c)": "Temp_C",
    "power (w)": "Power_W",
    # Portuguese labels (older / regional exports)
    "tempo": "Time",
    "velocidade (km/h)": "Speed_kmh",
    "ritmo (min/km)": "Pace_minkm",
    "distância (m)": "Distance_m",
    "distancia (m)": "Distance_m",
    "temperatura (°c)": "Temp_C",
    "temperatura (c)": "Temp_C",
}

# Metadata fields that must stay as strings (not converted to float)
_META_STR_FIELDS = {"name", "sport", "date", "start_time", "duration", "notes"}

# Metadata key → canonical field name
_META_KEYS = {
    # English labels (real Polar Flow export)
    "name": "name",
    "sport": "sport",
    "date": "date",
    "start time": "start_time",
    "duration": "duration",
    "total distance (km)": "total_distance_km",
    "average heart rate (bpm)": "hr_mean_meta",
    "average speed (km/h)": "avg_speed_kmh",
    "max speed (km/h)": "max_speed_kmh",
    "average pace (min/km)": "avg_pace_minkm",
    "max pace (min/km)": "max_pace_minkm",
    "calories": "calories_meta",
    "fat percentage of calories(%)": "fat_pct",
    "carbohydrate percentage of calories(%)": "carb_pct",
    "protein percentage of calories(%)": "protein_pct",
    "average cadence (rpm)": "avg_cadence_rpm",
    "average stride length (cm)": "avg_stride_cm",
    "running index": "running_index",
    "training load": "training_load",
    "ascent (m)": "ascent_m",
    "descent (m)": "descent_m",
    "average power (w)": "avg_power_w",
    "max power (w)": "max_power_w",
    "notes": "notes",
    "height (cm)": "height_cm",
    "weight (kg)": "weight_kg",
    "hr max": "hr_max_meta",
    "hr sit": "hr_sit_meta",
    "vo2max": "vo2max_meta",
    # Portuguese labels (older / regional exports)
    "nome": "name",
    "desporto": "sport",
    "duração": "duration",
    "duracao": "duration",
    "distância": "total_distance_km",
    "distancia": "total_distance_km",
    "fc média": "hr_mean_meta",
    "fc media": "hr_mean_meta",
    "calorias": "calories_meta",
    "altura": "height_cm",
    "peso": "weight_kg",
    "fc máx": "hr_max_meta",
    "fc max": "hr_max_meta",
}


def _detect_separator(raw_text: str) -> str:
    """Return ',' or ';' based on which appears more on the first four lines."""
    first_lines = raw_text.splitlines()[:4]
    commas = sum(line.count(",") for line in first_lines)
    semicolons = sum(line.count(";") for line in first_lines)
    return ";" if semicolons > commas else ","


def _read_raw(filepath: Path) -> tuple[list[list[str]], str]:
    """Try utf-8 → latin-1 → cp1252. Return (rows, separator)."""
    for enc in ("utf-8", "latin-1", "cp1252"):
        try:
            text = filepath.read_text(encoding=enc)
            sep = _detect_separator(text)
            rows = [
                [cell.strip() for cell in line.split(sep)]
                for line in text.splitlines()
            ]
            return rows, sep
        except UnicodeDecodeError:
            continue
    raise ValueError(f"Cannot decode {filepath} with utf-8, latin-1, or cp1252")


def _parse_metadata(rows: list[list[str]]) -> dict[str, Any]:
    """Extract key-value pairs from the first two metadata rows."""
    meta: dict[str, Any] = {}
    if len(rows) < 2:
        return meta

    keys_row = rows[0]
    vals_row = rows[1]

    for k, v in zip(keys_row, vals_row):
        canonical = _META_KEYS.get(k.lower().strip())
        if not canonical:
            continue
        v = v.strip()
        if not v:
            meta[canonical] = None
            continue
        if canonical in _META_STR_FIELDS:
            meta[canonical] = v
        else:
            try:
                meta[canonical] = float(re.sub(r"[^\d.]", "", v.replace(",", ".")))
            except (ValueError, TypeError):
                meta[canonical] = v or None

    return meta


def _find_timeseries_start(rows: list[list[str]]) -> int:
    """Return the row index of the time-series header."""
    for i, row in enumerate(rows):
        if not row:
            continue
        first_cell = row[0].lower().strip()
        # Polar Flow EN: header row starts with 'sample rate'
        if first_cell == "sample rate":
            return i
        # Older exports: header starts with 'tempo' or 'time'
        if first_cell in ("tempo", "time"):
            return i
        # Or the first data row itself is already a timestamp
        if re.match(r"^\d{1,2}:\d{2}:\d{2}$", first_cell):
            return i
    return 2  # fallback: skip first two metadata rows


def _build_timeseries(rows: list[list[str]], header_idx: int) -> pd.DataFrame:
    """Build a DataFrame from the time-series portion."""
    block = rows[header_idx:]
    if not block:
        return pd.DataFrame()

    raw_header = [c.lower().strip() for c in block[0]]
    data_rows = block[1:]

    df = pd.DataFrame(data_rows, columns=raw_header)

    # Drop the 'sample rate' bookkeeping column if present
    df = df.drop(columns=["sample rate"], errors="ignore")

    # Rename to canonical names
    rename = {col: _COL_MAP[col] for col in df.columns if col in _COL_MAP}
    df = df.rename(columns=rename)

    # Drop fully-empty rows
    df = df.dropna(how="all")
    df = df[df.apply(lambda r: any(str(c).strip() for c in r), axis=1)]

    # Convert Time to timedelta
    if "Time" in df.columns:
        df["Time"] = pd.to_timedelta(df["Time"].astype(str), errors="coerce")
        df["Time_s"] = df["Time"].dt.total_seconds().astype("Int64")

    # Pace (min/km) is stored as mm:ss — convert to decimal minutes
    if "Pace_minkm" in df.columns:
        def _pace_to_decimal(val: str) -> float | None:
            val = str(val).strip().replace(",", ".")
            if re.match(r"^\d{1,3}:\d{2}$", val):
                mins, secs = val.split(":")
                return int(mins) + int(secs) / 60
            try:
                return float(val)
            except (ValueError, TypeError):
                return None
        df["Pace_minkm"] = df["Pace_minkm"].apply(_pace_to_decimal)

    # Numeric coercion for all remaining sensor columns
    skip = {"Time", "Pace_minkm"}
    for col in [c for c in df.columns if c not in skip]:
        df[col] = (
            df[col].astype(str).str.replace(",", ".", regex=False).str.strip()
        )
        df[col] = pd.to_numeric(df[col], errors="coerce")

    df = df.reset_index(drop=True)
    return df


def parse_polar_csv(filepath: str | Path) -> dict[str, Any]:
    """
    Parse a Polar Flow exported CSV.

    Returns
    -------
    dict with keys:
        'metadata'   : dict of session-level metrics from the header block
        'timeseries' : pd.DataFrame at 1 Hz with canonical column names
        'source_file': resolved Path string
    On error, logs and returns empty structures (never raises).
    """
    filepath = Path(filepath).resolve()

    try:
        rows, sep = _read_raw(filepath)
        logger.debug("Parsed %s with separator=%r", filepath.name, sep)

        metadata = _parse_metadata(rows)
        ts_start = _find_timeseries_start(rows)
        timeseries = _build_timeseries(rows, ts_start)

        if timeseries.empty:
            logger.warning("No time-series data found in %s", filepath.name)

        return {
            "metadata": metadata,
            "timeseries": timeseries,
            "source_file": str(filepath),
        }

    except Exception as exc:  # noqa: BLE001
        logger.error("Failed to parse %s: %s", filepath, exc, exc_info=True)
        return {
            "metadata": {},
            "timeseries": pd.DataFrame(),
            "source_file": str(filepath),
        }
