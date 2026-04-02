#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PYTHON_BIN="${PYTHON_BIN:-python}"
TARGET="${1:-current}"
TAURI_ICON_ICO_PATH="$ROOT_DIR/src-tauri/icons/icon.ico"
TAURI_ICON_ICNS_PATH="$ROOT_DIR/src-tauri/icons/icon.icns"
TAURI_ICON_PNG_PATH="$ROOT_DIR/src-tauri/icons/icon.png"

cd "$ROOT_DIR"

echo "[0/4] Validate Tauri bundle icons"
for icon_path in "$TAURI_ICON_ICO_PATH" "$TAURI_ICON_ICNS_PATH" "$TAURI_ICON_PNG_PATH"; do
  if [[ ! -f "$icon_path" ]]; then
    echo "Missing Tauri icon: $icon_path"
    echo "Run: npm run tauri icon <source.png>"
    exit 1
  fi
done

echo "[1/4] Build Python sidecar binary"
mkdir -p src-tauri/binaries

OCR_FONT_NAME="NotoSansCJK-Regular.ttc"
OCR_FONT_BUNDLE_PATH="src-tauri/binaries/$OCR_FONT_NAME"
OCR_FONT_SOURCE_PATH="${DICTOVER_OCR_FONT_SOURCE:-sidecar/fonts/$OCR_FONT_NAME}"

if [[ ! -f "$OCR_FONT_BUNDLE_PATH" ]]; then
  if [[ -f "$OCR_FONT_SOURCE_PATH" ]]; then
    cp "$OCR_FONT_SOURCE_PATH" "$OCR_FONT_BUNDLE_PATH"
  else
    echo "Missing $OCR_FONT_NAME. Put it at sidecar/fonts/$OCR_FONT_NAME or set DICTOVER_OCR_FONT_SOURCE before build."
    exit 1
  fi
fi

cd sidecar
"$PYTHON_BIN" -m pip install pyinstaller -q
"$PYTHON_BIN" -m pyinstaller main.py --onefile --name dictover-sidecar --distpath ../src-tauri/binaries/

cd "$ROOT_DIR"
echo "[2/4] Run tests"
cargo test --manifest-path src-tauri/Cargo.toml
if [[ -d "sidecar/tests" ]]; then
  "$PYTHON_BIN" -m pip install pytest -q
  "$PYTHON_BIN" -m pytest sidecar/tests/ -q
fi
npm install
npm run test:integration

echo "[3/4] Build Tauri app (target=$TARGET)"
if [[ "$TARGET" == "current" ]]; then
  npm run tauri build
else
  npm run tauri build -- --target "$TARGET"
fi

echo "[4/4] Build artifacts"
ls -la src-tauri/target/release/bundle || true
