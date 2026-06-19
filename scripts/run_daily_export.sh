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

# ── Resolver o Python com as dependências instaladas ─────────────────────────
# Prioridade: venv do projeto → pyenv (onde pandas/supabase estão instalados)
# → python3 do sistema (fallback, provavelmente sem dependências).
# Usar sempre caminho absoluto para funcionar em shell limpo (Task Scheduler,
# cron, wsl.exe) onde o PATH não tem pyenv shims.
if   [ -f "$REPO_ROOT/.venv/bin/python3" ]; then
    PYTHON="$REPO_ROOT/.venv/bin/python3"
elif [ -f "$REPO_ROOT/venv/bin/python3"  ]; then
    PYTHON="$REPO_ROOT/venv/bin/python3"
elif [ -f "/home/bruno1008/.pyenv/versions/3.11.6/bin/python3" ]; then
    PYTHON="/home/bruno1008/.pyenv/versions/3.11.6/bin/python3"
else
    PYTHON="$(which python3 2>/dev/null || echo python3)"
fi

echo "[run_daily_export] Python: $PYTHON"

# ── Mudar para a raiz do repositório (necessário para imports de src/) ────────
cd "$REPO_ROOT"

# ── Executar exportação + relatórios ─────────────────────────────────────────
EXIT_CODE=0
"$PYTHON" "$REPO_ROOT/scripts/daily_export.py" \
    --reports \
    --log-file "$LOG_FILE" \
    "$@" \
    || EXIT_CODE=$?

exit $EXIT_CODE
