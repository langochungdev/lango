#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PYTHON_BIN="${PYTHON_BIN:-python}"
SIDECAR_PORT="${SIDECAR_PORT:-49152}"
OCR_FONT_NAME="NotoSansCJK-Regular.ttc"
OCR_FONT_BUNDLE_PATH="$ROOT_DIR/src-tauri/binaries/$OCR_FONT_NAME"
OCR_FONT_SOURCE_PATH="${DICTOVER_OCR_FONT_SOURCE:-$ROOT_DIR/sidecar/fonts/$OCR_FONT_NAME}"

cleanup() {
  if [[ -n "${SIDECAR_PID:-}" ]]; then
    kill "$SIDECAR_PID" >/dev/null 2>&1 || true
  fi
}

trap cleanup EXIT

echo "[1/3] Start Python sidecar"
cd "$ROOT_DIR/sidecar"
"$PYTHON_BIN" -m pip install -r requirements.txt -q
"$PYTHON_BIN" -m uvicorn main:app --port "$SIDECAR_PORT" --reload &
SIDECAR_PID=$!

cd "$ROOT_DIR"
echo "[2/4] Install frontend deps"
npm install

echo "[3/4] Ensure OCR font resource"
mkdir -p "$ROOT_DIR/src-tauri/binaries"
if [[ ! -f "$OCR_FONT_BUNDLE_PATH" ]]; then
  if [[ -f "$OCR_FONT_SOURCE_PATH" ]]; then
    cp "$OCR_FONT_SOURCE_PATH" "$OCR_FONT_BUNDLE_PATH"
  elif [[ -f "/c/Windows/Fonts/arial.ttf" ]]; then
    cp "/c/Windows/Fonts/arial.ttf" "$OCR_FONT_BUNDLE_PATH"
  else
    echo "Missing $OCR_FONT_NAME. Place it at sidecar/fonts/$OCR_FONT_NAME or set DICTOVER_OCR_FONT_SOURCE."
    exit 1
  fi
fi

echo "[4/4] Start Tauri dev"
SIDECAR_PORT="$SIDECAR_PORT" npm run tauri dev
