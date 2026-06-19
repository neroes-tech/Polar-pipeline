#!/usr/bin/env python3
"""
daily_export.py — Exportação e análise de dados HE26.

Uso:
  python scripts/daily_export.py                # exporta só sessões novas
  python scripts/daily_export.py --force        # reexporta tudo do zero
  python scripts/daily_export.py --reports      # exporta + gera relatórios
  python scripts/daily_export.py --reports-only # só relatórios (sem exportar)
  python scripts/daily_export.py --all          # alias de --force

A pasta de destino é configurada em EXPORT_DIR abaixo, ou pela variável
de ambiente HE26_EXPORT_DIR.
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

# ── Configuração ──────────────────────────────────────────────────────────────
REPO_ROOT  = Path(__file__).resolve().parent.parent
EXPORT_DIR = Path(
    os.environ.get("HE26_EXPORT_DIR", str(REPO_ROOT / "HE26_export"))
)

# Adicionar src/ ao path para imports relativos
sys.path.insert(0, str(REPO_ROOT))


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
    return p.parse_args()


# ── Passo 1: Exportação ───────────────────────────────────────────────────────

def run_export(export_dir: Path, force: bool) -> tuple[int, int, list[str]]:
    from src.export_engine import ExportEngine
    engine = ExportEngine(export_dir)
    return engine.run(force=force, verbose=True)


# ── Passo 2: Relatórios ───────────────────────────────────────────────────────

def run_reports(export_dir: Path) -> None:
    from src.report_engine import generate_participant_report, generate_global_report

    print("\n══════════════════════════════════════════")
    print("  Geração de relatórios")
    print("══════════════════════════════════════════\n")

    # Relatórios por participante
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

    # Relatório geral
    geral = generate_global_report(export_dir)
    if geral:
        print(f"\n  ✓ Relatório geral: {geral.name}")
    else:
        print("\n  ⚠ Sem dados suficientes para relatório geral")

    print(f"\n  {n_rel} relatório(s) de participante gerado(s)")
    print("══════════════════════════════════════════\n")


# ── Main ──────────────────────────────────────────────────────────────────────

def main() -> None:
    args = parse_args()
    export_dir = Path(args.export_dir)

    print(f"\nHE26 Export  ·  destino: {export_dir}")

    n_new = n_skip = 0
    errors: list[str] = []

    if not args.reports_only:
        n_new, n_skip, errors = run_export(export_dir, force=args.force)

    if args.reports or args.reports_only:
        run_reports(export_dir)

    # Código de saída: 0 se sem erros, 1 se houve pelo menos um erro
    if errors:
        print("Erros registados:")
        for e in errors:
            print(f"  {e}")
        sys.exit(1)

    sys.exit(0)


if __name__ == "__main__":
    main()
