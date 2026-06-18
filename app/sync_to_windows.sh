#!/usr/bin/env bash
# sync_to_windows.sh
# Build web assets, sync Capacitor, and copy to Windows filesystem
# so Android Studio can open it natively (WSL2 \\wsl$\... paths break Gradle).
#
# DESTINATION STRUCTURE on Windows:
#   neroes_app_android/
#   ├── android/          ← open THIS folder in Android Studio
#   └── node_modules/     ← @capacitor/* needed by capacitor.settings.gradle
#
# The capacitor.settings.gradle uses relative paths '../node_modules/...'
# from android/, which resolves to neroes_app_android/node_modules/ — correct.
#
# Usage: ./sync_to_windows.sh   (run from app/ directory)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WIN_USER="bruno"
WIN_ROOT="/mnt/c/Users/${WIN_USER}/neroes_app_android"   # destination root
WIN_PATH="C:\\Users\\${WIN_USER}\\neroes_app_android\\android"   # open in AS

echo ""
echo "══════════════════════════════════════════════"
echo "  Neroes HRV — Sync to Windows"
echo "══════════════════════════════════════════════"
echo ""

# ── Step 1: Web build ─────────────────────────────────────────
echo "▶ [1/3] Building web assets (npm run build)..."
cd "$SCRIPT_DIR"
npm run build --silent
echo "  ✓ dist/ ready"

# ── Step 2: Capacitor sync ────────────────────────────────────
echo ""
echo "▶ [2/3] Syncing Capacitor (npx cap sync android)..."
npx cap sync android 2>&1 | grep -E "✔|✗|Copying|Updating|error|Error" || true
echo "  ✓ android/ synced"

# ── Step 3: Copy to Windows filesystem ───────────────────────
echo ""
echo "▶ [3/3] Copying to ${WIN_ROOT}..."

if [ ! -d "/mnt/c/Users/${WIN_USER}" ]; then
    echo "  ✗ ERROR: /mnt/c/Users/${WIN_USER} not found."
    exit 1
fi

mkdir -p "${WIN_ROOT}/android"
mkdir -p "${WIN_ROOT}/node_modules/@capacitor"
mkdir -p "${WIN_ROOT}/node_modules/@capacitor-community"

# 3a. android/ → neroes_app_android/android/
rsync -a --delete \
    --exclude='.gradle/' \
    --exclude='build/intermediates/' \
    --exclude='build/tmp/' \
    --exclude='build/generated/' \
    --exclude='.idea/' \
    "${SCRIPT_DIR}/android/" \
    "${WIN_ROOT}/android/"

# 3b. node_modules the capacitor.settings.gradle points to:
#     '../node_modules/@capacitor/android/capacitor'
#     '../node_modules/@capacitor/haptics/android'
#     '../node_modules/@capacitor-community/bluetooth-le/android'
# Copy only those three packages (total ~1.8 MB — fast).

rsync -a --delete \
    --exclude='node_modules/' \
    --exclude='.gradle/' \
    --exclude='build/' \
    "${SCRIPT_DIR}/node_modules/@capacitor/android/" \
    "${WIN_ROOT}/node_modules/@capacitor/android/"

rsync -a --delete \
    --exclude='node_modules/' \
    --exclude='build/' \
    "${SCRIPT_DIR}/node_modules/@capacitor/haptics/" \
    "${WIN_ROOT}/node_modules/@capacitor/haptics/"

rsync -a --delete \
    --exclude='node_modules/' \
    --exclude='build/' \
    "${SCRIPT_DIR}/node_modules/@capacitor-community/bluetooth-le/" \
    "${WIN_ROOT}/node_modules/@capacitor-community/bluetooth-le/"

# Fix permissions
chmod -R 755 "${WIN_ROOT}" 2>/dev/null || true

# Create local.properties with Windows SDK path (never committed to git)
cat > "${WIN_ROOT}/android/local.properties" <<'EOF'
sdk.dir=C\:\\Users\\bruno\\AppData\\Local\\Android\\Sdk
EOF

NFILES=$(find "${WIN_ROOT}" -type f | wc -l)
echo "  ✓ ${NFILES} files in Windows copy"
echo ""
echo "══════════════════════════════════════════════"
echo "  PRONTO. Abre no Android Studio:"
echo ""
echo "    ${WIN_PATH}"
echo ""
echo "  File → Open → navega até essa pasta"
echo "  (é a pasta android/ DENTRO de neroes_app_android)"
echo "══════════════════════════════════════════════"
echo ""
