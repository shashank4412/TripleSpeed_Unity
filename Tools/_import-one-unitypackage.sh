#!/usr/bin/env bash
# Extract a .unitypackage into a Unity project without running the Editor.
# A .unitypackage is a gzipped tar of <guid>/{asset,asset.meta,pathname}.
# "Importing" a package with no import-time codegen is exactly this copy.
set -euo pipefail

PKG="$1"
PROJ="$2"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

tar -xzf "$PKG" -C "$TMP"

n=0
for d in "$TMP"/*/; do
  [ -f "$d/pathname" ] || continue
  rel="$(head -1 "$d/pathname")"
  case "$rel" in
    Assets/*|ProjectSettings/*) : ;;
    *) continue ;;
  esac
  dst="$PROJ/$rel"
  mkdir -p "$(dirname "$dst")"
  if [ -f "$d/asset" ]; then
    cp -f "$d/asset" "$dst"
    [ -f "$d/asset.meta" ] && cp -f "$d/asset.meta" "$dst.meta"
    n=$((n+1))
  elif [ -f "$d/asset.meta" ] && [ ! -e "$dst" ]; then
    # folder-only entry
    mkdir -p "$dst"
    cp -f "$d/asset.meta" "$dst.meta"
  fi
done
echo "$(basename "$PKG"): $n files"
