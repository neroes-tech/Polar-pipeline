"""
feature_engineering.py — Cleaning, anomaly flagging, and aggregation.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

HR_MIN = 30
HR_MAX = 220
GAP_THRESHOLD_S = 2     # seconds — gap detection
MAX_INTERPOLATE_S = 5   # seconds — gaps ≤ this get interpolated


# ── Cleaning helpers ──────────────────────────────────────────────────────────

def remove_hr_outliers(df: pd.DataFrame) -> pd.DataFrame:
    """Set HR_bpm to NaN for physiologically impossible values."""
    if "HR_bpm" not in df.columns:
        return df
    mask = (df["HR_bpm"] < HR_MIN) | (df["HR_bpm"] > HR_MAX)
    df = df.copy()
    df.loc[mask, "HR_bpm"] = np.nan
    return df


def detect_time_gaps(df: pd.DataFrame) -> pd.DataFrame:
    """
    Add a boolean column 'gap_before' — True when the time jump from the
    previous row exceeds GAP_THRESHOLD_S.
    """
    df = df.copy()
    if "Time_s" not in df.columns:
        df["gap_before"] = False
        return df
    dt = df["Time_s"].diff().fillna(0)
    df["gap_before"] = dt > GAP_THRESHOLD_S
    return df


def interpolate_short_gaps(df: pd.DataFrame) -> pd.DataFrame:
    """
    Linear interpolation of HR_bpm across gaps ≤ MAX_INTERPOLATE_S seconds.
    Gaps larger than that are left as NaN.
    """
    if "HR_bpm" not in df.columns or "Time_s" not in df.columns:
        return df
    df = df.copy()
    nan_mask = df["HR_bpm"].isna()
    # Only interpolate where gap is small
    # Build gap length in seconds for each NaN run
    gap_id = (nan_mask != nan_mask.shift()).cumsum()
    for gid, group in df[nan_mask].groupby(gap_id[nan_mask]):
        if len(group) == 0:
            continue
        idx = group.index
        t_start = df.loc[idx[0], "Time_s"]
        t_end = df.loc[idx[-1], "Time_s"]
        gap_s = (t_end - t_start) if pd.notna(t_end) and pd.notna(t_start) else MAX_INTERPOLATE_S + 1
        if gap_s <= MAX_INTERPOLATE_S:
            df.loc[idx, "HR_bpm"] = np.nan  # will be filled by interpolate
    df["HR_bpm"] = df["HR_bpm"].interpolate(method="linear", limit=MAX_INTERPOLATE_S)
    return df


# ── Anomaly detection ─────────────────────────────────────────────────────────

def add_anomaly_flags(
    df: pd.DataFrame,
    z_thresh: float = 3.0,
    use_iqr: bool = True,
) -> pd.DataFrame:
    """
    Add columns:
        is_anomaly_zscore  : |z-score| > z_thresh within participant+day window
        is_anomaly_iqr     : value outside [Q1 - 1.5*IQR, Q3 + 1.5*IQR]
        is_anomaly         : union of both (or just z-score if use_iqr=False)
    """
    df = df.copy()
    group_cols = [c for c in ("User_ID", "Date") if c in df.columns]

    if "HR_bpm" not in df.columns:
        df["is_anomaly"] = False
        return df

    def _zscore_flag(series: pd.Series) -> pd.Series:
        mu, sigma = series.mean(), series.std()
        if sigma == 0 or pd.isna(sigma):
            return pd.Series(False, index=series.index)
        return ((series - mu).abs() / sigma) > z_thresh

    def _iqr_flag(series: pd.Series) -> pd.Series:
        q1, q3 = series.quantile(0.25), series.quantile(0.75)
        iqr = q3 - q1
        return (series < q1 - 1.5 * iqr) | (series > q3 + 1.5 * iqr)

    if group_cols:
        df["is_anomaly_zscore"] = df.groupby(group_cols)["HR_bpm"].transform(_zscore_flag)
        if use_iqr:
            df["is_anomaly_iqr"] = df.groupby(group_cols)["HR_bpm"].transform(_iqr_flag)
    else:
        df["is_anomaly_zscore"] = _zscore_flag(df["HR_bpm"])
        if use_iqr:
            df["is_anomaly_iqr"] = _iqr_flag(df["HR_bpm"])

    if use_iqr:
        df["is_anomaly"] = df["is_anomaly_zscore"] | df["is_anomaly_iqr"]
    else:
        df["is_anomaly"] = df["is_anomaly_zscore"]

    return df


# ── Aggregation ───────────────────────────────────────────────────────────────

def build_master_short(
    df_long: pd.DataFrame,
    meta_df: pd.DataFrame | None = None,
) -> pd.DataFrame:
    """
    Aggregate master_long_clean (1 Hz) to one row per (User_ID, Date).

    Parameters
    ----------
    df_long   : cleaned long-format DataFrame
    meta_df   : optional DataFrame with demographic columns indexed on User_ID

    Returns
    -------
    DataFrame with columns: User_ID, Date, Day_of_Week,
        FC_mean, FC_std, FC_variance, FC_min, FC_max, FC_range,
        calories, duration_s, data_quality_pct, + demographic cols
    """
    if df_long.empty:
        return pd.DataFrame()

    group_cols = [c for c in ("User_ID", "Date", "Day_of_Week") if c in df_long.columns]
    agg_key = [c for c in ("User_ID", "Date") if c in group_cols]

    def _agg(g: pd.DataFrame) -> pd.Series:
        hr = g["HR_bpm"].dropna()
        total = len(g)
        valid = len(hr)
        return pd.Series(
            {
                "FC_mean": hr.mean(),
                "FC_std": hr.std(),
                "FC_variance": hr.var(),
                "FC_min": hr.min(),
                "FC_max": hr.max(),
                "FC_range": hr.max() - hr.min(),
                "duration_s": int(g["Time_s"].max()) if "Time_s" in g.columns else total,
                "data_quality_pct": round(100.0 * valid / total, 2) if total else 0.0,
                "calories": g["calories_meta"].iloc[0] if "calories_meta" in g.columns else np.nan,
                "Day_of_Week": g["Day_of_Week"].iloc[0] if "Day_of_Week" in g.columns else None,
            }
        )

    short = df_long.groupby(agg_key).apply(_agg).reset_index()

    if meta_df is not None and not meta_df.empty:
        short = short.merge(meta_df, on="User_ID", how="left")

    return short
