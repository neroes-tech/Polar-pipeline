"""
report_engine.py — Geração de relatórios HTML para o estudo HE26.

Gera dois tipos de relatório:
  1. Por participante: evolução temporal das métricas HRV
  2. Geral do estudo: comparação entre participantes

Todos os gráficos são incorporados como base64 PNG — o HTML é um
ficheiro único auto-contido, não precisa de ligação à internet.

Dependências: matplotlib, seaborn, pandas (já em requirements.txt).
"""

from __future__ import annotations

import base64
import io
import json
from datetime import datetime
from pathlib import Path

import matplotlib
matplotlib.use("Agg")  # sem display (corre em background/WSL)
import matplotlib.pyplot as plt
import matplotlib.dates as mdates
import pandas as pd
import seaborn as sns

# Paleta da identidade visual Neroes (teal × blue)
TEAL  = "#2BBDBD"
BLUE  = "#3D6EF5"
WARN  = "#D97706"
ERR   = "#DC2626"

TIPO_CORES = {
    "rest_5min_manha": TEAL,
    "rest_5min_tarde": BLUE,
    "livre_1h":        WARN,
}
TIPO_LABELS = {
    "rest_5min_manha": "Repouso – Manhã",
    "rest_5min_tarde": "Repouso – Tarde",
    "livre_1h":        "Sessão Livre",
}

sns.set_theme(style="whitegrid", palette="muted")


# ── Utilitários ───────────────────────────────────────────────────────────────

def _fig_to_base64(fig: plt.Figure) -> str:
    """Converte figura matplotlib em string base64 para incorporar no HTML."""
    buf = io.BytesIO()
    fig.savefig(buf, format="png", dpi=110, bbox_inches="tight",
                facecolor="white", edgecolor="none")
    buf.seek(0)
    plt.close(fig)
    return base64.b64encode(buf.read()).decode("ascii")


def _img_tag(b64: str, alt: str = "") -> str:
    return f'<img src="data:image/png;base64,{b64}" alt="{alt}" style="max-width:100%;border-radius:8px;margin:12px 0">'


def _html_page(title: str, body: str, subtitle: str = "") -> str:
    """Gera página HTML auto-contida."""
    now = datetime.now().strftime("%Y-%m-%d %H:%M")
    return f"""<!DOCTYPE html>
<html lang="pt">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{title}</title>
<style>
  :root{{--teal:{TEAL};--blue:{BLUE}}}
  *{{box-sizing:border-box;margin:0;padding:0}}
  body{{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
        background:#F2FBFB;color:#1A1F3A;line-height:1.6}}
  .header{{background:linear-gradient(135deg,{TEAL} 0%,{BLUE} 100%);
           color:#fff;padding:32px 40px 28px}}
  .header h1{{font-size:1.8rem;font-weight:800;letter-spacing:-.02em}}
  .header p{{color:rgba(255,255,255,.75);font-size:.9rem;margin-top:6px}}
  .container{{max-width:960px;margin:0 auto;padding:32px 24px 60px}}
  h2{{color:var(--teal);font-size:1.2rem;font-weight:700;
      margin:36px 0 12px;padding-bottom:6px;
      border-bottom:2px solid #DDF0F0}}
  h3{{color:#2D4040;font-size:1rem;font-weight:700;margin:24px 0 8px}}
  table{{width:100%;border-collapse:collapse;font-size:.85rem;
         background:#fff;border-radius:10px;overflow:hidden;
         box-shadow:0 2px 12px rgba(43,189,189,.08)}}
  th{{background:linear-gradient(135deg,{TEAL} 0%,{BLUE} 100%);
      color:#fff;padding:10px 14px;text-align:left;font-weight:700;
      font-size:.78rem;letter-spacing:.04em}}
  td{{padding:9px 14px;border-bottom:1px solid #DDF0F0;
      font-variant-numeric:tabular-nums}}
  tr:last-child td{{border-bottom:none}}
  tr:hover td{{background:#F7FEFE}}
  .badge{{display:inline-block;padding:2px 8px;border-radius:999px;
          font-size:.72rem;font-weight:700}}
  .badge-good{{background:#D1FAE5;color:#047857}}
  .badge-fair{{background:#FEF3C7;color:#D97706}}
  .badge-poor{{background:#FEE2E2;color:#DC2626}}
  .stat-grid{{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));
              gap:14px;margin:16px 0}}
  .stat-card{{background:#fff;border:1px solid #DDF0F0;border-radius:12px;
              padding:16px;box-shadow:0 2px 8px rgba(43,189,189,.06)}}
  .stat-card .val{{font-size:1.6rem;font-weight:800;color:var(--teal);
                   font-variant-numeric:tabular-nums}}
  .stat-card .lbl{{font-size:.72rem;font-weight:600;color:#7AAEAE;
                   text-transform:uppercase;letter-spacing:.05em;margin-top:4px}}
  .footer{{text-align:center;color:#7AAEAE;font-size:.75rem;
           padding:20px;border-top:1px solid #DDF0F0;margin-top:40px}}
</style>
</head>
<body>
<div class="header">
  <h1>{title}</h1>
  <p>{subtitle} &nbsp;·&nbsp; Gerado em {now}</p>
</div>
<div class="container">
{body}
</div>
<div class="footer">Neroes HRV · Estudo HE26 · gerado por report_engine.py</div>
</body>
</html>"""


def _quality_badge(flag: str | None) -> str:
    css = {"good": "badge-good", "fair": "badge-fair", "poor": "badge-poor"}.get(
        str(flag or ""), "badge-poor"
    )
    return f'<span class="badge {css}">{flag or "—"}</span>'


def _fmt(v, decimals: int = 2) -> str:
    if v is None or (isinstance(v, float) and pd.isna(v)):
        return "—"
    return f"{v:.{decimals}f}"


# ── Recolher dados de uma pasta de participante ───────────────────────────────

def _load_participant_sessions(participant_dir: Path) -> pd.DataFrame:
    """
    Lê todos os metrics.json de um participante e devolve DataFrame.
    Linha = uma sessão.
    """
    records = []
    for metrics_file in sorted(participant_dir.rglob("metrics.json")):
        try:
            data = json.loads(metrics_file.read_text(encoding="utf-8"))
            row = {**data.get("metadata", {}), **data.get("hrv_metrics", {})}
            # pasta relativa como identificador do tipo de sessão
            rel = metrics_file.parent.relative_to(participant_dir)
            parts = rel.parts  # (date, tipo)
            row["folder"] = str(rel)
            row["tipo_pasta"] = parts[-1] if parts else "?"
            records.append(row)
        except Exception:
            pass

    if not records:
        return pd.DataFrame()

    df = pd.DataFrame(records)
    df["session_date"] = pd.to_datetime(df["session_date"], errors="coerce")
    df["session_time"] = pd.to_datetime(
        df["session_time"].astype(str), format="%H:%M:%S", errors="coerce"
    ).dt.time

    for col in ["lnrmssd", "rmssd", "sdnn", "pnn50", "hr_resting_mean",
                "hr_min", "hr_max", "data_quality_pct", "n_rr"]:
        if col in df.columns:
            df[col] = pd.to_numeric(df[col], errors="coerce")

    return df.sort_values("session_date")


# ── Relatório por participante ────────────────────────────────────────────────

def generate_participant_report(participant_dir: Path) -> Path | None:
    """
    Gera _relatorio.html e _sessoes.csv na pasta do participante.
    Devolve o caminho do HTML ou None se não houver dados.
    """
    code = participant_dir.name
    df   = _load_participant_sessions(participant_dir)

    if df.empty:
        return None

    # ── Guardar CSV de sessões ────────────────────────────────────────────────
    cols_csv = ["session_date", "tipo_pasta", "session_time", "duration_s",
                "lnrmssd", "rmssd", "sdnn", "pnn50",
                "hr_resting_mean", "hr_min", "hr_max",
                "data_quality_pct", "quality_flag", "n_rr", "has_ecg"]
    cols_csv = [c for c in cols_csv if c in df.columns]
    df[cols_csv].to_csv(participant_dir / "_sessoes.csv", index=False)

    # ── Estatísticas gerais ───────────────────────────────────────────────────
    n_sess    = len(df)
    n_dias    = df["session_date"].nunique()
    qual_med  = df["data_quality_pct"].mean()
    lnrmssd_m = df["lnrmssd"].mean()

    stat_html = f"""
<div class="stat-grid">
  <div class="stat-card"><div class="val">{n_sess}</div><div class="lbl">Sessões</div></div>
  <div class="stat-card"><div class="val">{n_dias}</div><div class="lbl">Dias de dados</div></div>
  <div class="stat-card"><div class="val">{_fmt(qual_med, 1)}%</div><div class="lbl">Qualidade média</div></div>
  <div class="stat-card"><div class="val">{_fmt(lnrmssd_m)}</div><div class="lbl">lnRMSSD médio</div></div>
</div>"""

    # ── Gráficos de evolução temporal ─────────────────────────────────────────
    charts = []
    metricas_plot = [
        ("lnrmssd",          "lnRMSSD",           "lnRMSSD (u.a.)"),
        ("rmssd",            "RMSSD",              "RMSSD (ms)"),
        ("hr_resting_mean",  "FC de Repouso",      "FC (bpm)"),
        ("data_quality_pct", "Qualidade do Sinal", "Qualidade (%)"),
    ]

    tipos_presentes = df["tipo_pasta"].dropna().unique()

    for col, titulo, ylabel in metricas_plot:
        if col not in df.columns or df[col].isna().all():
            continue

        fig, ax = plt.subplots(figsize=(9, 3.8))
        ax.set_title(titulo, fontsize=13, fontweight="bold", pad=10, color="#1A1F3A")
        ax.set_ylabel(ylabel, fontsize=10, color="#4A6060")
        ax.set_xlabel("Data", fontsize=10, color="#4A6060")

        for tipo in tipos_presentes:
            sub = df[df["tipo_pasta"] == tipo].dropna(subset=[col, "session_date"])
            if sub.empty:
                continue
            cor   = TIPO_CORES.get(tipo, "#888")
            label = TIPO_LABELS.get(tipo, tipo)
            ax.plot(sub["session_date"], sub[col],
                    "o-", color=cor, label=label, linewidth=2, markersize=6)

        ax.xaxis.set_major_formatter(mdates.DateFormatter("%d/%m"))
        ax.xaxis.set_major_locator(mdates.DayLocator(interval=max(1, n_dias // 8)))
        plt.setp(ax.get_xticklabels(), rotation=30, ha="right", fontsize=9)
        ax.yaxis.set_tick_params(labelsize=9)
        ax.spines[["top", "right"]].set_visible(False)
        if len(tipos_presentes) > 1:
            ax.legend(fontsize=9, framealpha=0.8)

        fig.tight_layout()
        charts.append(_img_tag(_fig_to_base64(fig), titulo))

    # ── Tabela de sessões ─────────────────────────────────────────────────────
    rows_html = ""
    for _, row in df.iterrows():
        tipo_label = TIPO_LABELS.get(str(row.get("tipo_pasta", "")), str(row.get("tipo_pasta", "—")))
        badge      = _quality_badge(row.get("quality_flag"))
        rows_html += f"""<tr>
          <td>{row['session_date'].strftime('%Y-%m-%d') if pd.notna(row.get('session_date')) else '—'}</td>
          <td>{tipo_label}</td>
          <td>{str(row.get('session_time', '—'))[:8]}</td>
          <td>{_fmt(row.get('lnrmssd'))}</td>
          <td>{_fmt(row.get('rmssd'), 1)}</td>
          <td>{_fmt(row.get('sdnn'), 1)}</td>
          <td>{_fmt(row.get('pnn50'), 1)}</td>
          <td>{_fmt(row.get('hr_resting_mean'), 1)}</td>
          <td>{int(row['n_rr']) if pd.notna(row.get('n_rr')) else '—'}</td>
          <td>{badge}</td>
        </tr>"""

    tabela = f"""
<table>
  <thead><tr>
    <th>Data</th><th>Tipo</th><th>Hora</th>
    <th>lnRMSSD</th><th>RMSSD (ms)</th><th>SDNN (ms)</th><th>pNN50 (%)</th>
    <th>FC méd. (bpm)</th><th>N_RR</th><th>Qualidade</th>
  </tr></thead>
  <tbody>{rows_html}</tbody>
</table>"""

    # ── Montar HTML ───────────────────────────────────────────────────────────
    body = f"""
<h2>Resumo</h2>
{stat_html}

<h2>Evolução Temporal</h2>
{"".join(charts) if charts else "<p>Dados insuficientes para gráficos.</p>"}

<h2>Tabela de Sessões</h2>
{tabela}
"""

    html = _html_page(
        title    = f"Relatório — {code}",
        subtitle = f"Estudo HE26 · {n_sess} sessões · {n_dias} dias",
        body     = body,
    )

    out = participant_dir / "_relatorio.html"
    from src.export_engine import _write_text_atomic
    _write_text_atomic(out, html)
    return out


# ── Relatório geral do estudo ─────────────────────────────────────────────────

def generate_global_report(export_dir: Path) -> Path | None:
    """
    Gera _relatorio_geral.html na raiz da exportação.
    Agrega dados de todos os participantes.
    """
    all_frames: dict[str, pd.DataFrame] = {}
    for p_dir in sorted(export_dir.iterdir()):
        if not p_dir.is_dir() or p_dir.name.startswith("_"):
            continue
        df = _load_participant_sessions(p_dir)
        if not df.empty:
            df["participant_code"] = p_dir.name
            all_frames[p_dir.name] = df

    if not all_frames:
        return None

    master = pd.concat(all_frames.values(), ignore_index=True)
    codes  = list(all_frames.keys())
    n_part = len(codes)
    n_sess = len(master)
    n_dias = master["session_date"].nunique()
    qual_m = master["data_quality_pct"].mean()

    # ── Cards de sumário ──────────────────────────────────────────────────────
    stat_html = f"""
<div class="stat-grid">
  <div class="stat-card"><div class="val">{n_part}</div><div class="lbl">Participantes</div></div>
  <div class="stat-card"><div class="val">{n_sess}</div><div class="lbl">Sessões totais</div></div>
  <div class="stat-card"><div class="val">{n_dias}</div><div class="lbl">Dias de recolha</div></div>
  <div class="stat-card"><div class="val">{_fmt(qual_m, 1)}%</div><div class="lbl">Qualidade média</div></div>
</div>"""

    charts = []

    # ── Gráfico: box plot de lnRMSSD por participante ─────────────────────────
    if "lnrmssd" in master.columns and master["lnrmssd"].notna().any():
        fig, ax = plt.subplots(figsize=(max(6, n_part * 0.9 + 2), 4))
        data_box = [
            all_frames[c]["lnrmssd"].dropna().values
            for c in codes
            if c in all_frames and not all_frames[c]["lnrmssd"].dropna().empty
        ]
        labels_box = [c for c in codes if c in all_frames and not all_frames[c]["lnrmssd"].dropna().empty]
        bp = ax.boxplot(data_box, labels=labels_box, patch_artist=True,
                        medianprops=dict(color=TEAL, linewidth=2.5))
        for patch in bp["boxes"]:
            patch.set_facecolor(f"{TEAL}22")
            patch.set_edgecolor(TEAL)
        ax.set_title("Distribuição de lnRMSSD por Participante",
                     fontsize=13, fontweight="bold", color="#1A1F3A", pad=10)
        ax.set_ylabel("lnRMSSD", fontsize=10, color="#4A6060")
        ax.spines[["top", "right"]].set_visible(False)
        fig.tight_layout()
        charts.append(_img_tag(_fig_to_base64(fig), "lnRMSSD por participante"))

    # ── Gráfico: número de sessões por participante ───────────────────────────
    sess_counts = master.groupby("participant_code").size().reindex(codes, fill_value=0)
    fig, ax = plt.subplots(figsize=(max(5, n_part * 0.9 + 1.5), 3.5))
    bars = ax.bar(sess_counts.index, sess_counts.values, color=TEAL, alpha=0.85, width=0.6)
    ax.bar_label(bars, padding=3, fontsize=9, color="#1A1F3A", fontweight="bold")
    ax.set_title("Sessões por Participante", fontsize=13, fontweight="bold",
                 color="#1A1F3A", pad=10)
    ax.set_ylabel("Nº sessões", fontsize=10, color="#4A6060")
    ax.spines[["top", "right"]].set_visible(False)
    fig.tight_layout()
    charts.append(_img_tag(_fig_to_base64(fig), "Sessões por participante"))

    # ── Gráfico: qualidade média por participante ─────────────────────────────
    if "data_quality_pct" in master.columns:
        qual_by_p = master.groupby("participant_code")["data_quality_pct"].mean().reindex(codes)
        fig, ax = plt.subplots(figsize=(max(5, n_part * 0.9 + 1.5), 3.5))
        colors = [TEAL if v >= 80 else WARN if v >= 70 else ERR
                  for v in qual_by_p.fillna(0)]
        bars = ax.bar(qual_by_p.index, qual_by_p.values, color=colors, alpha=0.85, width=0.6)
        ax.bar_label(bars, fmt="%.1f%%", padding=3, fontsize=8.5, color="#1A1F3A")
        ax.axhline(80, color=TEAL,  linestyle="--", linewidth=1.2, alpha=0.7, label="Bom (≥80%)")
        ax.axhline(70, color=WARN,  linestyle="--", linewidth=1.0, alpha=0.7, label="Razoável (≥70%)")
        ax.set_ylim(0, 105)
        ax.set_title("Qualidade Média por Participante", fontsize=13, fontweight="bold",
                     color="#1A1F3A", pad=10)
        ax.set_ylabel("Qualidade (%)", fontsize=10, color="#4A6060")
        ax.legend(fontsize=9)
        ax.spines[["top", "right"]].set_visible(False)
        fig.tight_layout()
        charts.append(_img_tag(_fig_to_base64(fig), "Qualidade por participante"))

    # ── Tabela resumo por participante ────────────────────────────────────────
    rows_html = ""
    for c in codes:
        df_p = all_frames[c]
        rows_html += f"""<tr>
          <td><strong>{c}</strong></td>
          <td>{len(df_p)}</td>
          <td>{df_p['session_date'].nunique()}</td>
          <td>{_fmt(df_p['lnrmssd'].mean())}</td>
          <td>{_fmt(df_p['rmssd'].mean(), 1)}</td>
          <td>{_fmt(df_p['hr_resting_mean'].mean(), 1)}</td>
          <td>{_fmt(df_p['data_quality_pct'].mean(), 1)}%</td>
        </tr>"""

    tabela = f"""
<table>
  <thead><tr>
    <th>Participante</th><th>Sessões</th><th>Dias</th>
    <th>lnRMSSD méd.</th><th>RMSSD méd. (ms)</th>
    <th>FC méd. (bpm)</th><th>Qualidade méd.</th>
  </tr></thead>
  <tbody>{rows_html}</tbody>
</table>"""

    body = f"""
<h2>Resumo do Estudo</h2>
{stat_html}

<h2>Comparação entre Participantes</h2>
{"".join(charts)}

<h2>Tabela Resumo</h2>
{tabela}
"""

    html = _html_page(
        title    = "Relatório Geral — Estudo HE26",
        subtitle = f"{n_part} participantes · {n_sess} sessões · {n_dias} dias de recolha",
        body     = body,
    )

    out = export_dir / "_relatorio_geral.html"
    from src.export_engine import _write_text_atomic
    _write_text_atomic(out, html)
    return out
