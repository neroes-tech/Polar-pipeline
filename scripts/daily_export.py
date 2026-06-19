#!/usr/bin/env python3
"""
daily_export.py — Exportação e análise de dados HE26.

Uso manual:
  python scripts/daily_export.py                # exporta sessões novas
  python scripts/daily_export.py --force        # reexporta tudo do zero
  python scripts/daily_export.py --reports      # exporta + gera relatórios
  python scripts/daily_export.py --reports-only # só relatórios (sem exportar)
  python scripts/daily_export.py --no-drive     # sem cópia para o Drive

Uso automático (chamado por run_daily_export.sh):
  python scripts/daily_export.py --reports --log-file HE26_export/_run_log.txt

A pasta de destino é configurada em EXPORT_DIR abaixo, ou pela variável
de ambiente HE26_EXPORT_DIR.
"""

from __future__ import annotations

import argparse
import os
import subprocess
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
# Destino Google Drive (pasta Windows acessível via /mnt/c no WSL).
# Sobreposto por --drive-dir ou pela variável de ambiente HE26_DRIVE_DIR.
DRIVE_DIR_DEFAULT = Path(
    os.environ.get(
        "HE26_DRIVE_DIR",
        "/mnt/c/Users/bruno/Documents/HE26_Drive/HE26_export",
    )
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
        help=f"Pasta raiz da exportação local (default: {EXPORT_DIR})",
    )
    p.add_argument(
        "--drive-dir",
        default=str(DRIVE_DIR_DEFAULT),
        metavar="PATH",
        dest="drive_dir",
        help=f"Destino Google Drive (default: {DRIVE_DIR_DEFAULT})",
    )
    p.add_argument(
        "--no-drive",
        action="store_true",
        dest="no_drive",
        help="Desligar a cópia para o Google Drive.",
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


# ── Passo 3: Cópia para o Google Drive ───────────────────────────────────────

def run_drive_copy(src: Path, dst: Path) -> tuple[str, int]:
    """
    Copia src/ para dst/ de forma incremental usando rsync (sem --delete).
    Nunca apaga nada na origem nem no destino.

    Devolve (estado, n_ficheiros_copiados).
      estado : "OK", "FALHOU (<motivo>)", ou "AVISO (<motivo>)"
    """
    print("\n══════════════════════════════════════════")
    print("  Cópia para Google Drive")
    print(f"  origem : {src}")
    print(f"  destino: {dst}")
    print("══════════════════════════════════════════\n")

    # Verificar acessibilidade do destino pai antes de tentar criar
    if not dst.parent.exists():
        msg = f"pasta pai não acessível: {dst.parent}"
        print(f"  ⚠ Drive não disponível — {msg}")
        return f"FALHOU ({msg})", 0

    try:
        dst.mkdir(parents=True, exist_ok=True)
    except OSError as e:
        msg = f"não foi possível criar pasta de destino: {e}"
        print(f"  ✗ {msg}")
        return f"FALHOU ({msg})", 0

    # rsync -a --update: copia novos/modificados, nunca apaga
    # --out-format=%n lista cada ficheiro transferido (um por linha)
    try:
        result = subprocess.run(
            [
                "rsync", "-a", "--update",
                "--out-format=%n",
                f"{src}/",   # trailing slash = copia conteúdo (não a pasta em si)
                f"{dst}/",
            ],
            capture_output=True,
            text=True,
            timeout=300,  # 5 minutos máx
        )
    except FileNotFoundError:
        # rsync não instalado — fallback para cp -ru
        return _drive_copy_fallback(src, dst)
    except subprocess.TimeoutExpired:
        return "FALHOU (timeout após 5 min)", 0

    if result.returncode != 0:
        stderr = result.stderr.strip().replace("\n", " ")[:200]
        print(f"  ✗ rsync falhou (código {result.returncode}): {stderr}")
        return f"FALHOU (rsync código {result.returncode}: {stderr})", 0

    transferred = [l for l in result.stdout.splitlines() if l.strip()]
    n = len(transferred)

    if n:
        for f in transferred[:10]:   # mostra os primeiros 10
            print(f"  → {f}")
        if n > 10:
            print(f"  … e mais {n - 10} ficheiro(s)")
    else:
        print("  ✓ Drive já actualizado (nenhum ficheiro novo)")

    print(f"\n  ✓ {n} ficheiro(s) copiado(s) para o Drive")
    print("══════════════════════════════════════════\n")
    return "OK", n


def _drive_copy_fallback(src: Path, dst: Path) -> tuple[str, int]:
    """Fallback para cp -ru quando rsync não está disponível."""
    try:
        result = subprocess.run(
            ["cp", "-ru", f"{src}/.", str(dst)],
            capture_output=True, text=True, timeout=300,
        )
        if result.returncode != 0:
            err = result.stderr.strip()[:200]
            return f"FALHOU (cp: {err})", 0
        print("  ✓ Cópia via cp -ru concluída (rsync não disponível)")
        return "OK (cp)", 0
    except Exception as e:
        return f"FALHOU ({e})", 0


# ── Main ──────────────────────────────────────────────────────────────────────

def main() -> None:
    args       = parse_args()
    export_dir = Path(args.export_dir)
    drive_dir  = Path(args.drive_dir)
    log_path   = Path(args.log_file) if args.log_file else None
    t_start    = time.monotonic()

    print(f"\nHE26 Export  ·  destino: {export_dir}")
    if args.force:
        print("  modo: --force (reexporta tudo)")
    if args.no_drive:
        print("  drive: desligado (--no-drive)")

    n_new       = 0
    n_skip      = 0
    n_reports   = 0
    drive_state = "desligado"
    drive_files = 0
    errors: list[str] = []

    try:
        # ── 1. Exportação local (fonte da verdade) ────────────────────────────
        if not args.reports_only:
            n_new, n_skip, errors = run_export(export_dir, force=args.force)

        # ── 2. Relatórios HTML ────────────────────────────────────────────────
        if args.reports or args.reports_only:
            n_reports = run_reports(export_dir)

        # ── 3. Cópia para o Drive (depois da exportação local estar completa) ─
        if not args.no_drive:
            drive_state, drive_files = run_drive_copy(export_dir, drive_dir)

    except Exception as exc:
        elapsed   = time.monotonic() - t_start
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

    if log_path:
        ts      = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        drive_s = (
            f"drive={drive_state} ficheiros={drive_files}"
            if drive_state != "desligado"
            else "drive=desligado"
        )
        summary = (
            f"novas={n_new} saltas={n_skip} erros={len(errors)} "
            f"relatórios={n_reports} duração={elapsed:.1f}s | {drive_s}"
        )
        _log_append(log_path, f"{ts} | {status:<5} | {summary}")

    sys.exit(1 if errors else 0)


if __name__ == "__main__":
    main()
