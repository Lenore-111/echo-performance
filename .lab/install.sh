#!/usr/bin/env bash
set -euo pipefail
: "${ST_DIR:?}" "${TARGET_DIR:?}" "${EXT_DIR:?}"
mkdir -p "$EXT_DIR"
cp "$TARGET_DIR/manifest.json" "$TARGET_DIR/index.js" "$TARGET_DIR/style.css" "$EXT_DIR/"
mkdir -p "$EXT_DIR/src"
cp "$TARGET_DIR/src/viewport.js" "$TARGET_DIR/src/dom-compact.js" "$TARGET_DIR/src/native-bridge.js" "$EXT_DIR/src/"
