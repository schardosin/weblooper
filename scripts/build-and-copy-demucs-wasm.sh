#!/usr/bin/env bash
set -euo pipefail

# This script builds the demucs-rs WASM (6-stem capable) and copies it into weblooper.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BUILD_DIR="/tmp/demucs-rs-build"
OUT_DIR="/tmp/demucs-wasm-out"
TARGET_DIR="$PROJECT_ROOT/src/vendor/demucs-rs"

echo "==> Building demucs-rs WASM (this can take a long time on first build)..."

if [ ! -d "$BUILD_DIR" ]; then
  echo "Cloning demucs-rs..."
  git clone --depth 1 https://github.com/nikhilunni/demucs-rs.git "$BUILD_DIR"
fi

cd "$BUILD_DIR/demucs-wasm"

echo "Running wasm-pack build (release, web target)..."
wasm-pack build --target web --out-dir "$OUT_DIR" --release

echo "Copying artifacts to $TARGET_DIR ..."
mkdir -p "$TARGET_DIR"
cp "$OUT_DIR"/* "$TARGET_DIR"/

echo "Done. Artifacts are in src/vendor/demucs-rs/"
echo "You can now run 'npm run dev' and use 6-stem separation (guitar + piano)."
