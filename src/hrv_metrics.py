"""
hrv_metrics.py — Scientific HRV computation from raw RR intervals.

All inputs and outputs are in milliseconds unless stated otherwise.
Time-domain metrics follow ESC/NASPE Task Force guidelines (1996).

Typical 5-minute resting values for reference:
    RMSSD   : 20–80 ms (higher = more parasympathetic activity)
    lnRMSSD : 3.0–4.4  (log-linearised, used for between-subject comparison)
    pNN50   : 3–40 %
    SDNN    : 20–100 ms
"""

from __future__ import annotations

import math

import numpy as np

# ── Physiological thresholds ──────────────────────────────────────────────────
RR_MIN_MS          = 300    # 200 bpm — upper HR limit
RR_MAX_MS          = 1500   # 40 bpm  — lower HR limit
ECTOPIC_THRESHOLD  = 0.20   # 20% deviation from preceding RR → ectopic beat
QUALITY_GOOD_PCT   = 80.0
QUALITY_FAIR_PCT   = 70.0


def filter_artifacts(rr: list | np.ndarray) -> tuple[np.ndarray, int]:
    """
    Remove physiologically impossible RR intervals and ectopic beats.

    Two-pass filter:
      1. Range filter  — remove RR outside [RR_MIN_MS, RR_MAX_MS]
      2. Ectopic filter — remove beats where |rr[i] - rr[i-1]| / rr[i-1] > 20%

    Parameters
    ----------
    rr : array-like of RR intervals in milliseconds

    Returns
    -------
    (clean_rr, n_removed)
        clean_rr  : np.ndarray of valid RR intervals (ms)
        n_removed : int — number of intervals removed
    """
    arr = np.asarray(rr, dtype=float)
    n_orig = len(arr)

    # Pass 1: physiological range
    arr = arr[(arr >= RR_MIN_MS) & (arr <= RR_MAX_MS)]

    # Pass 2: ectopic beats
    if len(arr) >= 2:
        keep = np.ones(len(arr), dtype=bool)
        for i in range(1, len(arr)):
            prev = arr[i - 1]
            if prev > 0 and abs(arr[i] - prev) / prev > ECTOPIC_THRESHOLD:
                keep[i] = False
        arr = arr[keep]

    return arr, n_orig - len(arr)


def compute_hrv(rr: list | np.ndarray) -> dict:
    """
    Compute standard time-domain HRV metrics from raw RR intervals.

    Applies artifact filtering before computing metrics.
    If fewer than 2 valid intervals remain, returns None values with
    quality_flag = "insufficient_data".

    Parameters
    ----------
    rr : array-like of RR intervals in milliseconds

    Returns
    -------
    dict with keys:
        n_rr             : int   — valid intervals after filtering
        mean_rr          : float — mean RR interval (ms)
        hr_resting_mean  : float — mean HR in bpm (60 000 / mean_rr)
        hr_min           : float — minimum HR bpm (60 000 / max_rr)
        hr_max           : float — maximum HR bpm (60 000 / min_rr)
        sdnn             : float — SD of all NN intervals (ms); total variability
        rmssd            : float — root mean square of successive diffs (ms)
        lnrmssd          : float — natural log of RMSSD; parasympathetic proxy
        pnn50            : float — % of successive diffs > 50 ms
        data_quality_pct : float — % of original RR kept after filtering
        quality_flag     : str   — "good" (≥80%) / "fair" (70-80%) /
                                   "poor" (<70%) / "insufficient_data"
    """
    arr_orig = np.asarray(rr, dtype=float)
    n_orig   = len(arr_orig)

    _null = {
        "n_rr": 0, "mean_rr": None, "hr_resting_mean": None,
        "hr_min": None, "hr_max": None, "sdnn": None,
        "rmssd": None, "lnrmssd": None, "pnn50": None,
        "data_quality_pct": 0.0, "quality_flag": "insufficient_data",
    }

    if n_orig < 2:
        return _null

    clean, _ = filter_artifacts(arr_orig)
    n_clean  = len(clean)
    quality_pct = 100.0 * n_clean / n_orig

    if n_clean < 2:
        return {**_null, "data_quality_pct": round(quality_pct, 2)}

    # ── Quality flag ─────────────────────────────────────────────────────────
    if quality_pct >= QUALITY_GOOD_PCT:
        flag = "good"
    elif quality_pct >= QUALITY_FAIR_PCT:
        flag = "fair"
    else:
        flag = "poor"

    # ── Time-domain metrics ───────────────────────────────────────────────────
    mean_rr   = float(np.mean(clean))
    diffs     = np.diff(clean)
    abs_diffs = np.abs(diffs)

    sdnn    = float(np.std(clean, ddof=1))
    rmssd   = float(math.sqrt(float(np.mean(diffs ** 2))))
    lnrmssd = float(math.log(rmssd)) if rmssd > 0 else None
    pnn50   = float(100.0 * np.sum(abs_diffs > 50) / len(abs_diffs))

    return {
        "n_rr":             n_clean,
        "mean_rr":          round(mean_rr, 2),
        "hr_resting_mean":  round(60000.0 / mean_rr, 2),
        "hr_min":           round(60000.0 / float(np.max(clean)), 2),
        "hr_max":           round(60000.0 / float(np.min(clean)), 2),
        "sdnn":             round(sdnn, 3),
        "rmssd":            round(rmssd, 3),
        "lnrmssd":          round(lnrmssd, 4) if lnrmssd is not None else None,
        "pnn50":            round(pnn50, 2),
        "data_quality_pct": round(quality_pct, 2),
        "quality_flag":     flag,
    }
