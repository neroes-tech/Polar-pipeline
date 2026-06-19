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
# Plugin detection is AUTOMATIC: the script reads android/capacitor.settings.gradle
# and copies every node_modules package it references. Adding a new Capacitor
# plugin and running `npx cap sync` updates that file — next sync picks it up.
#
# Usage: ./sync_to_windows.sh   (run from app/ directory)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WIN_USER="bruno"
WIN_ROOT="/mnt/c/Users/${WIN_USER}/neroes_app_android"
WIN_PATH="C:\\Users\\${WIN_USER}\\neroes_app_android\\android"

echo ""
echo "══════════════════════════════════════════════"
echo "  Neroes HRV — Sync to Windows"
echo "══════════════════════════════════════════════"
echo ""

# ── Step 1: Web build ─────────────────────────────────────────────────────────
echo "▶ [1/3] Building web assets (npm run build)..."
cd "$SCRIPT_DIR"
npm run build --silent
echo "  ✓ dist/ ready"

# ── Step 2: Capacitor sync ────────────────────────────────────────────────────
echo ""
echo "▶ [2/3] Syncing Capacitor (npx cap sync android)..."
npx cap sync android 2>&1 | grep -E "✔|✗|Copying|Updating|error|Error" || true
echo "  ✓ android/ synced"

# ── Step 3: Copy to Windows filesystem ───────────────────────────────────────
echo ""
echo "▶ [3/3] Copying to ${WIN_ROOT}..."

if [ ! -d "/mnt/c/Users/${WIN_USER}" ]; then
    echo "  ✗ ERROR: /mnt/c/Users/${WIN_USER} not found."
    exit 1
fi

SETTINGS="${SCRIPT_DIR}/android/capacitor.settings.gradle"
if [ ! -f "$SETTINGS" ]; then
    echo "  ✗ ERROR: ${SETTINGS} not found — run 'npx cap sync android' first."
    exit 1
fi

mkdir -p "${WIN_ROOT}/android"

# 3a. android/ → neroes_app_android/android/
# keystore.properties lives ONLY on Windows — never delete it with --delete.
rsync -a --delete \
    --exclude='.gradle/' \
    --exclude='build/intermediates/' \
    --exclude='build/tmp/' \
    --exclude='build/generated/' \
    --exclude='.idea/' \
    --exclude='keystore.properties' \
    "${SCRIPT_DIR}/android/" \
    "${WIN_ROOT}/android/"

# 3b. Capacitor plugin node_modules — auto-detected from capacitor.settings.gradle
#
# capacitor.settings.gradle lines look like:
#   project(':foo').projectDir = new File('../node_modules/@scope/pkg/android')
#
# We extract the unique npm package paths (everything up to the last path segment
# that is NOT part of the npm package name, i.e. we strip the trailing /android,
# /src, etc. that come after the package name).
#
# Strategy: extract everything between 'node_modules/' and the closing quote,
# then strip the trailing non-package path component (the Android sub-folder).
# npm scoped packages look like @scope/name, so we keep exactly 2 path segments
# after node_modules/ for scoped packages and 1 for unscoped.

echo ""
echo "  Detecting Capacitor plugins from capacitor.settings.gradle..."

declare -A SEEN  # dedup map

while IFS= read -r LINE; do
    # Extract the path inside new File('...') — strip everything before node_modules/
    if [[ "$LINE" =~ node_modules/([^\'\"]+) ]]; then
        PKG_PATH="${BASH_REMATCH[1]}"
        # Determine npm package name:
        # - scoped:   @scope/name/android  → @scope/name
        # - unscoped: name/android         → name
        if [[ "$PKG_PATH" == @*/* ]]; then
            # scoped package: take first two segments
            PKG=$(echo "$PKG_PATH" | cut -d'/' -f1,2)
        else
            PKG=$(echo "$PKG_PATH" | cut -d'/' -f1)
        fi

        if [[ -z "${SEEN[$PKG]+x}" ]]; then
            SEEN[$PKG]=1
            SRC="${SCRIPT_DIR}/node_modules/${PKG}"
            DST="${WIN_ROOT}/node_modules/${PKG}"
            if [ -d "$SRC" ]; then
                mkdir -p "$(dirname "$DST")"
                rsync -a --delete \
                    --exclude='node_modules/' \
                    --exclude='.gradle/' \
                    --exclude='build/' \
                    "$SRC/" "$DST/"
                echo "    ✓ ${PKG}"
            else
                echo "    ✗ MISSING: ${PKG} (not in node_modules — run npm install?)"
            fi
        fi
    fi
done < "$SETTINGS"

# Fix permissions
chmod -R 755 "${WIN_ROOT}" 2>/dev/null || true

# Create local.properties with Windows SDK path (never committed to git)
cat > "${WIN_ROOT}/android/local.properties" <<'EOF'
sdk.dir=C\:\\Users\\bruno\\AppData\\Local\\Android\\Sdk
EOF

NFILES=$(find "${WIN_ROOT}" -type f | wc -l)
echo ""
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
