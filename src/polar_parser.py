"""
polar_parser.py — Parse exported Polar Flow CSV files.

CSV layout (Polar H10 / Polar Flow export):
  Rows 0-1  : metadata block  (key-value pairs, variable number of columns)
  Row 2     : blank or header sentinel — skipped automatically
  Row 3+    : time-series at 1 Hz
              columns: Tempo, HR (bpm), Velocidade (km/h), Ritmo (min/km),
                       Altitude (m), Distância (m), Temperatura (°C)
"""

from __future__ import annotations

import logging
import re
from pathlib import Path
from typing import Any

import pandas as pd

logger = logging.getLogger(__name__)

# ── canonical column rename map (handles both PT and EN exports) ──────────────
_COL_MAP = {
    # Portuguese labels
    "tempo": "Time",
    "hr (bpm)": "HR_bpm",
    "velocidade (km/h)": "Speed_kmh",
    "ritmo (min/km)": "Pace_minkm",
    "altitude (m)": "Altitude_m",
    "distância (m)": "Distance_m",
    "distancia (m)": "Distance_m",
    "temperatura (°c)": "Temp_C",
    "temperatura (c)": "Temp_C",
    # English labels (some exports)
    "time": "Time",
    "heart rate (bpm)": "HR_bpm",
    "speed (km/h)": "Speed_kmh",
    "pace (min/km)": "Pace_minkm",
    "altitude (m)": "Altitude_m",
    "distance (m)": "Distance_m",
    "temperature (°c)": "Temp_C",
}

# Keys expected in the metadata block (first two rows)
_META_KEYS = {
    "nome": "name",
    "name": "name",
    "desporto": "sport",
    "sport": "sport",
    "duração": "duration",
    "duration": "duration",
    "distância": "total_distance_m",
    "distance": "total_distance_m",
    "fc média": "hr_mean_meta",
    "average hr": "hr_mean_meta",
    "calorias": "calories_meta",
    "calories": "calories_meta",
    "altura": "height_cm",
    "height": "height_cm",
    "peso": "weight_kg",
    "weight": "weight_kg",
    "fc máx": "hr_max_meta",
    "max hr": "hr_max_meta",
    "vo2max": "vo2max_meta",
}


def _detect_separator(raw_text: str) -> str:
    """Return ',' or ';' based on which appears more on the first data line."""
    first_lines = raw_text.splitlines()[:4]
    commas = sum(line.count(",") for line in first_lines)
    semicolons = sum(line.count(";") for line in first_lines)
    return ";" if semicolons > commas else ","


def _read_raw(filepath: Path) -> list[list[str]]:
    """Try utf-8, fall back to latin-1."""
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
    raise ValueError(f"Cannot decode {filepath} with utf-8 or latin-1")


def _parse_metadata(rows: list[list[str]]) -> dict[str, Any]:
    """Extract key-value pairs from the first two metadata rows."""
    meta: dict[str, Any] = {}
    # Row 0 → keys, Row 1 → values  (typical Polar Flow layout)
    # Alternatively both rows may be interleaved key/value pairs
    if len(rows) < 2:
        return meta

    keys_row = rows[0]
    vals_row = rows[1] if len(rows) > 1 else []

    for k, v in zip(keys_row, vals_row):
        canonical = _META_KEYS.get(k.lower().strip(), None)
        if canonical:
            # Attempt numeric conversion
            try:
                meta[canonical] = float(re.sub(r"[^\d.,]", "", v).replace(",", "."))
            except (ValueError, TypeError):
                meta[canonical] = v.strip() if v.strip() else None

    return meta


def _find_timeseries_start(rows: list[list[str]]) -> int:
    """Return the index of the first data row of the time-series block."""
    for i, row in enumerate(rows):
        if not row:
            continue
        first_cell = row[0].lower().strip()
        # The time-series header starts with 'tempo' / 'time'
        if first_cell in ("tempo", "time"):
            return i
        # Or the first cell looks like a timestamp hh:mm:ss / 00:00:00
        if re.match(r"^\d{1,2}:\d{2}:\d{2}$", first_cell):
            return i
    return 2  # safe fallback: skip first two rows


def _build_timeseries(rows: list[list[str]], header_idx: int) -> pd.DataFrame:
    """Build a DataFrame from the time-series portion of the CSV rows."""
    block = rows[header_idx:]
    if not block:
        return pd.DataFrame()

    raw_header = [c.lower().strip() for c in block[0]]
    data_rows = block[1:]

    df = pd.DataFrame(data_rows, columns=raw_header)

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

    # Numeric coercion for sensor columns
    num_cols = [c for c in df.columns if c != "Time"]
    for col in num_cols:
        df[col] = (
            df[col]
            .astype(str)
            .str.replace(",", ".", regex=False)
            .str.strip()
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
    On error, logs the exception and returns {'metadata': {}, 'timeseries': DataFrame(), ...}.
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
