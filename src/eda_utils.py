"""
eda_utils.py — Reusable visualisation helpers and HTML report generation.
"""

from __future__ import annotations

import io
import math
import base64
from pathlib import Path

import matplotlib.pyplot as plt
import matplotlib.ticker as mticker
import numpy as np
import pandas as pd
import seaborn as sns

# ── Global style ──────────────────────────────────────────────────────────────
sns.set_theme(style="whitegrid", palette="muted", font_scale=1.05)
FIGURE_DPI = 100


def _fig_to_base64(fig: plt.Figure) -> str:
    """Encode a matplotlib figure as a base64 PNG string for HTML embedding."""
    buf = io.BytesIO()
    fig.savefig(buf, format="png", dpi=FIGURE_DPI, bbox_inches="tight")
    buf.seek(0)
    encoded = base64.b64encode(buf.read()).decode("utf-8")
    plt.close(fig)
    return encoded


# ── A — Distributions ─────────────────────────────────────────────────────────

def plot_hr_distributions(df: pd.DataFrame) -> plt.Figure:
    """Histogram of HR per participant arranged in subplots."""
    participants = df["User_ID"].unique() if "User_ID" in df.columns else ["all"]
    n = len(participants)
    ncols = min(n, 3)
    nrows = math.ceil(n / ncols)
    fig, axes = plt.subplots(nrows, ncols, figsize=(6 * ncols, 4 * nrows), squeeze=False)
    axes_flat = axes.flatten()

    for i, pid in enumerate(participants):
        ax = axes_flat[i]
        data = df[df["User_ID"] == pid]["HR_bpm"].dropna() if "User_ID" in df.columns else df["HR_bpm"].dropna()
        ax.hist(data, bins=30, color="steelblue", edgecolor="white", linewidth=0.5)
        ax.set_title(str(pid))
        ax.set_xlabel("HR (bpm)")
        ax.set_ylabel("Count")

    for j in range(i + 1, len(axes_flat)):
        axes_flat[j].set_visible(False)

    fig.suptitle("HR Distribution per Participant", fontsize=14, fontweight="bold")
    fig.tight_layout(rect=[0, 0, 1, 0.96])
    return fig


def plot_hr_boxplot_weekday(df: pd.DataFrame) -> plt.Figure:
    """Boxplot of HR grouped by day of week."""
    day_order = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
    present = [d for d in day_order if d in df.get("Day_of_Week", pd.Series()).unique()]
    fig, ax = plt.subplots(figsize=(10, 5))
    sns.boxplot(
        data=df,
        x="Day_of_Week",
        y="HR_bpm",
        order=present or None,
        palette="coolwarm",
        ax=ax,
    )
    ax.set_title("HR Distribution by Day of Week")
    ax.set_xlabel("")
    ax.set_ylabel("HR (bpm)")
    fig.tight_layout()
    return fig


def plot_hr_heatmap(df_short: pd.DataFrame) -> plt.Figure:
    """Heatmap: participant × date (value = mean HR)."""
    if df_short.empty or "User_ID" not in df_short.columns:
        fig, ax = plt.subplots()
        ax.text(0.5, 0.5, "No data", ha="center", va="center")
        return fig

    pivot = df_short.pivot_table(index="User_ID", columns="Date", values="FC_mean", aggfunc="mean")
    fig, ax = plt.subplots(figsize=(max(8, len(pivot.columns) * 1.2), max(4, len(pivot) * 0.8)))
    sns.heatmap(
        pivot,
        annot=True,
        fmt=".0f",
        cmap="YlOrRd",
        linewidths=0.4,
        cbar_kws={"label": "Mean HR (bpm)"},
        ax=ax,
    )
    ax.set_title("Mean HR — Participant × Date")
    ax.set_xlabel("Date")
    ax.set_ylabel("Participant")
    fig.tight_layout()
    return fig


# ── B — Time Series ───────────────────────────────────────────────────────────

def plot_timeseries_grid(df: pd.DataFrame, participant: str) -> plt.Figure:
    """8-session grid for a single participant, with anomaly markers."""
    sub = df[df["User_ID"] == participant] if "User_ID" in df.columns else df
    dates = sorted(sub["Date"].unique()) if "Date" in sub.columns else [None]
    n = len(dates)
    ncols = min(4, n)
    nrows = math.ceil(n / ncols)
    fig, axes = plt.subplots(nrows, ncols, figsize=(5 * ncols, 3 * nrows), squeeze=False)
    axes_flat = axes.flatten()

    for i, date in enumerate(dates):
        ax = axes_flat[i]
        sess = sub[sub["Date"] == date] if date else sub
        x = sess.get("Time_s", pd.Series(range(len(sess))))
        y = sess["HR_bpm"]
        ax.plot(x, y, lw=1, color="steelblue", label="HR")
        if "is_anomaly" in sess.columns:
            anom = sess[sess["is_anomaly"]]
            ax.scatter(
                anom.get("Time_s", anom.index),
                anom["HR_bpm"],
                color="red",
                s=20,
                zorder=5,
                label="Anomaly",
            )
        ax.set_title(str(date) if date else participant)
        ax.set_xlabel("Time (s)")
        ax.set_ylabel("HR (bpm)")
        ax.xaxis.set_major_locator(mticker.MaxNLocator(5))

    for j in range(i + 1, len(axes_flat)):
        axes_flat[j].set_visible(False)

    handles, labels = axes_flat[0].get_legend_handles_labels()
    fig.legend(handles, labels, loc="upper right", fontsize=8)
    fig.suptitle(f"Sessions — {participant}", fontsize=13, fontweight="bold")
    fig.tight_layout(rect=[0, 0, 1, 0.95])
    return fig


# ── C — Anomaly summary ───────────────────────────────────────────────────────

def anomaly_summary_table(df: pd.DataFrame) -> pd.DataFrame:
    """Return % valid data and anomaly counts per (User_ID, Date)."""
    if df.empty or "HR_bpm" not in df.columns:
        return pd.DataFrame()

    group = [c for c in ("User_ID", "Date") if c in df.columns]

    def _stats(g):
        total = len(g)
        nan_count = g["HR_bpm"].isna().sum()
        anomaly_count = g.get("is_anomaly", pd.Series(False, index=g.index)).sum()
        return pd.Series(
            {
                "total_rows": total,
                "nan_hr": int(nan_count),
                "anomaly_count": int(anomaly_count),
                "pct_valid": round(100.0 * (total - nan_count) / total, 2) if total else 0.0,
            }
        )

    return df.groupby(group).apply(_stats).reset_index()


# ── D — Comparative ───────────────────────────────────────────────────────────

def plot_participant_comparison(df_short: pd.DataFrame) -> plt.Figure:
    """Bar chart: mean HR and FC_std per participant."""
    if df_short.empty or "User_ID" not in df_short.columns:
        fig, ax = plt.subplots()
        ax.text(0.5, 0.5, "No data", ha="center", va="center")
        return fig

    agg = df_short.groupby("User_ID")[["FC_mean", "FC_std"]].mean().reset_index()
    fig, axes = plt.subplots(1, 2, figsize=(12, 5))
    axes[0].bar(agg["User_ID"], agg["FC_mean"], color="steelblue")
    axes[0].set_title("Mean HR per Participant")
    axes[0].set_ylabel("HR (bpm)")
    axes[0].tick_params(axis="x", rotation=30)

    axes[1].bar(agg["User_ID"], agg["FC_std"], color="coral")
    axes[1].set_title("HR Std Dev per Participant")
    axes[1].set_ylabel("HR std (bpm)")
    axes[1].tick_params(axis="x", rotation=30)

    fig.tight_layout()
    return fig


def plot_weekly_trend(df_short: pd.DataFrame) -> plt.Figure:
    """Line chart: FC_mean over days, one line per participant."""
    if df_short.empty:
        fig, ax = plt.subplots()
        ax.text(0.5, 0.5, "No data", ha="center", va="center")
        return fig

    fig, ax = plt.subplots(figsize=(10, 5))
    for pid, group in df_short.groupby("User_ID"):
        g = group.sort_values("Date")
        ax.plot(g["Date"].astype(str), g["FC_mean"], marker="o", label=str(pid))
    ax.set_title("HR Trend Over 8 Days")
    ax.set_xlabel("Date")
    ax.set_ylabel("Mean HR (bpm)")
    ax.legend(title="Participant", bbox_to_anchor=(1.01, 1), loc="upper left")
    ax.tick_params(axis="x", rotation=30)
    fig.tight_layout()
    return fig


# ── E — HTML report export ────────────────────────────────────────────────────

_HTML_TEMPLATE = """\
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Neroes — Polar Pipeline EDA Report</title>
  <style>
    body {{ font-family: 'Segoe UI', sans-serif; margin: 0; background:#f5f6fa; color:#333; }}
    header {{ background:#1e3a5f; color:#fff; padding:24px 32px; }}
    header h1 {{ margin:0; font-size:1.6em; }}
    header p  {{ margin:4px 0 0; opacity:.8; font-size:.9em; }}
    main {{ max-width:1200px; margin:0 auto; padding:32px 16px; }}
    section {{ margin-bottom:48px; }}
    h2 {{ border-bottom:2px solid #1e3a5f; padding-bottom:6px; color:#1e3a5f; }}
    h3 {{ color:#2c5f8a; }}
    img {{ max-width:100%; border:1px solid #dde; border-radius:6px;
           box-shadow:0 2px 6px rgba(0,0,0,.12); margin:8px 0; }}
    table {{ border-collapse:collapse; width:100%; font-size:.88em; }}
    th {{ background:#1e3a5f; color:#fff; padding:8px 12px; text-align:left; }}
    td {{ padding:7px 12px; border-bottom:1px solid #e0e0e0; }}
    tr:nth-child(even) td {{ background:#f0f4f8; }}
    .metric-grid {{ display:flex; gap:16px; flex-wrap:wrap; margin:16px 0; }}
    .metric-card {{ background:#fff; border-radius:8px; padding:16px 20px;
                    min-width:160px; box-shadow:0 1px 4px rgba(0,0,0,.1); }}
    .metric-card .val {{ font-size:1.8em; font-weight:700; color:#1e3a5f; }}
    .metric-card .lbl {{ font-size:.8em; color:#666; }}
    footer {{ text-align:center; padding:24px; color:#999; font-size:.8em;
              border-top:1px solid #dde; margin-top:32px; }}
  </style>
</head>
<body>
<header>
  <h1>Neroes — Polar H10 Pipeline &nbsp;|&nbsp; EDA Report</h1>
  <p>Generated: {generated_at} &nbsp;|&nbsp; {n_participants} participants &nbsp;|&nbsp; {n_days} days &nbsp;|&nbsp; {n_records:,} records</p>
</header>
<main>
  {sections}
</main>
<footer>Auto-generated by neroes_polar_pipeline · 2026</footer>
</body>
</html>
"""


def export_html_report(
    figures: dict[str, plt.Figure | list[plt.Figure]],
    stats: pd.DataFrame | None,
    output_path: str | Path,
    meta: dict | None = None,
) -> Path:
    """
    Build a self-contained HTML report from matplotlib figures.

    Parameters
    ----------
    figures    : {'section_title': fig_or_list_of_figs}
    stats      : summary DataFrame included as an HTML table
    output_path: where to write the .html file
    meta       : dict with keys n_participants, n_days, n_records (for header)
    """
    import datetime

    meta = meta or {}
    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    sections_html = []

    for title, fig_item in figures.items():
        figs = fig_item if isinstance(fig_item, list) else [fig_item]
        imgs_html = "".join(
            f'<img src="data:image/png;base64,{_fig_to_base64(f)}" alt="{title}" />'
            for f in figs
        )
        sections_html.append(f"<section><h2>{title}</h2>{imgs_html}</section>")

    if stats is not None and not stats.empty:
        tbl = stats.to_html(index=False, classes="", border=0, float_format="{:.2f}".format)
        sections_html.append(f"<section><h2>Descriptive Statistics</h2>{tbl}</section>")

    html = _HTML_TEMPLATE.format(
        generated_at=datetime.datetime.now().strftime("%Y-%m-%d %H:%M"),
        n_participants=meta.get("n_participants", "—"),
        n_days=meta.get("n_days", "—"),
        n_records=meta.get("n_records", 0),
        sections="\n".join(sections_html),
    )

    output_path.write_text(html, encoding="utf-8")
    return output_path
