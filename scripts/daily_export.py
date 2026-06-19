#!/usr/bin/env python3
"""
daily_export.py — Exportação e análise de dados HE26.

Uso manual:
  python scripts/daily_export.py                # exporta sessões novas
  python scripts/daily_export.py --force        # reexporta tudo do zero
  python scripts/daily_export.py --reports      # exporta + gera relatórios
  python scripts/daily_export.py --reports-only # só relatórios (sem exportar)

Uso automático (chamado por run_daily_export.sh):
  python scripts/daily_export.py --reports --log-file HE26_export/_run_log.txt

A pasta de destino é configurada em EXPORT_DIR abaixo, ou pela variável
de ambiente HE26_EXPORT_DIR.
"""

from __future__ import annotations

import argparse
import os
import sys
import time
import traceback
from datetime import datetime
from pathlib import Path

# ── Configuração ──────────────────────────────────────────────────────────────
REPO_ROOT  = Path(__file__).resolve().parent.parent
EXPORT_DIR = Path(
    os.environ.get("HE26_EXPORT_DIR", str(REPO_ROOT / "HE26_export"))
)

sys.path.insert(0, str(REPO_ROOT))


# ── Logging para ficheiro (uma linha por execução) ────────────────────────────

def _log_append(log_path: Path, line: str) -> None:
    """Acrescenta uma linha ao ficheiro de log. Nunca falha nem interrompe o fluxo."""
    try:
        log_path.parent.mkdir(parents=True, exist_ok=True)
        with log_path.open("a", encoding="utf-8") as f:
            f.write(line + "\n")
    except OSError:
        pass


# ── CLI ───────────────────────────────────────────────────────────────────────

def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Exportação incremental de sessões HE26 do Supabase.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    p.add_argument(
        "--force", "--all", "-f",
        action="store_true",
        help="Reexportar todas as sessões, mesmo as já exportadas.",
    )
    p.add_argument(
        "--reports", "-r",
        action="store_true",
        help="Gerar relatórios HTML após a exportação.",
    )
    p.add_argument(
        "--reports-only",
        action="store_true",
        dest="reports_only",
        help="Só gerar relatórios (não exporta dados novos).",
    )
    p.add_argument(
        "--export-dir",
        default=str(EXPORT_DIR),
        metavar="PATH",
        help=f"Pasta raiz da exportação (default: {EXPORT_DIR})",
    )
    p.add_argument(
        "--log-file",
        default=None,
        metavar="PATH",
        dest="log_file",
        help=(
            "Ficheiro de log para execução autónoma (acrescenta, não sobrescreve). "
            "Regista uma linha por execução com data/hora, contagens e resultado."
        ),
    )
    return p.parse_args()


# ── Passo 1: Exportação ───────────────────────────────────────────────────────

def run_export(export_dir: Path, force: bool) -> tuple[int, int, list[str]]:
    from src.export_engine import ExportEngine
    engine = ExportEngine(export_dir)
    return engine.run(force=force, verbose=True)


# ── Passo 2: Relatórios ───────────────────────────────────────────────────────

def run_reports(export_dir: Path) -> int:
    """Gera relatórios e devolve o número de participantes com relatório gerado."""
    from src.report_engine import generate_participant_report, generate_global_report

    print("\n══════════════════════════════════════════")
    print("  Geração de relatórios")
    print("══════════════════════════════════════════\n")

    n_rel = 0
    for p_dir in sorted(export_dir.iterdir()):
        if not p_dir.is_dir() or p_dir.name.startswith("_"):
            continue
        out = generate_participant_report(p_dir)
        if out:
            print(f"  ✓ {p_dir.name}: {out.name}")
            n_rel += 1
        else:
            print(f"  ⚠ {p_dir.name}: sem dados suficientes para relatório")

    geral = generate_global_report(export_dir)
    if geral:
        print(f"\n  ✓ Relatório geral: {geral.name}")
    else:
        print("\n  ⚠ Sem dados suficientes para relatório geral")

    print(f"\n  {n_rel} relatório(s) de participante gerado(s)")
    print("══════════════════════════════════════════\n")
    return n_rel


# ── Main ──────────────────────────────────────────────────────────────────────

def main() -> None:
    args       = parse_args()
    export_dir = Path(args.export_dir)
    log_path   = Path(args.log_file) if args.log_file else None
    t_start    = time.monotonic()

    print(f"\nHE26 Export  ·  destino: {export_dir}")
    if args.force:
        print("  modo: --force (reexporta tudo)")

    n_new     = 0
    n_skip    = 0
    n_reports = 0
    errors: list[str] = []

    try:
        if not args.reports_only:
            n_new, n_skip, errors = run_export(export_dir, force=args.force)

        if args.reports or args.reports_only:
            n_reports = run_reports(export_dir)

    except Exception as exc:
        # Falha não recuperável: rede em baixo, secrets.yaml em falta, disco cheio, etc.
        elapsed = time.monotonic() - t_start
        err_short = f"{type(exc).__name__}: {exc}"
        print(f"\n[ERRO FATAL] {err_short}", file=sys.stderr)
        traceback.print_exc(file=sys.stderr)

        if log_path:
            ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            _log_append(log_path, f"{ts} | ERROR | {err_short} | duração={elapsed:.1f}s")

        sys.exit(1)

    # ── Resumo final ──────────────────────────────────────────────────────────
    elapsed = time.monotonic() - t_start
    status  = "ERROR" if errors else "OK"

    if errors:
        print("\nErros registados:")
        for e in errors:
            print(f"  {e}")

    # Linha estruturada para o ficheiro de log (uma por execução)
    if log_path:
        ts      = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        summary = (
            f"novas={n_new} saltas={n_skip} erros={len(errors)} "
            f"relatórios={n_reports} duração={elapsed:.1f}s"
        )
        _log_append(log_path, f"{ts} | {status:<5} | {summary}")

    sys.exit(1 if errors else 0)


if __name__ == "__main__":
    main()
