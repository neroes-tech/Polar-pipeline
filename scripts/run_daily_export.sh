#!/usr/bin/env bash
# run_daily_export.sh — Wrapper para execução autónoma diária do HE26 Export.
#
# Uso direto:
#   bash scripts/run_daily_export.sh
#
# Agendado (cron / Windows Task Scheduler):
#   wsl bash /home/bruno1008/Neroes/neroes_polar_pipeline/scripts/run_daily_export.sh
#
# Variáveis de ambiente opcionais:
#   HE26_EXPORT_DIR  — pasta de destino (default: <repo>/HE26_export)

set -uo pipefail

# ── Caminhos ─────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
EXPORT_DIR="${HE26_EXPORT_DIR:-$REPO_ROOT/HE26_export}"
LOG_FILE="$EXPORT_DIR/_run_log.txt"

mkdir -p "$EXPORT_DIR"

# ── Activar venv se existir ───────────────────────────────────────────────────
if   [ -f "$REPO_ROOT/.venv/bin/activate" ]; then
    # shellcheck source=/dev/null
    source "$REPO_ROOT/.venv/bin/activate"
elif [ -f "$REPO_ROOT/venv/bin/activate"  ]; then
    # shellcheck source=/dev/null
    source "$REPO_ROOT/venv/bin/activate"
fi

# ── Executar exportação + relatórios ─────────────────────────────────────────
EXIT_CODE=0
python3 "$REPO_ROOT/scripts/daily_export.py" \
    --reports \
    --log-file "$LOG_FILE" \
    "$@" \
    || EXIT_CODE=$?

exit $EXIT_CODE
