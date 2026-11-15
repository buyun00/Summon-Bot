#!/bin/bash
set -euo pipefail

sdk="$1"
available() {
  local developer="$1" version
  case "$developer" in
    *[Bb]eta*|*[Cc]andidate*) return 1 ;;
  esac
  version=$(DEVELOPER_DIR="$developer" xcrun --sdk "$sdk" --show-sdk-version 2>/dev/null) || return 1
  [[ "$version" =~ ^[0-9]+(\.[0-9]+)*$ ]] && (( ${version%%.*} >= 26 ))
}

selected="$(xcode-select -p 2>/dev/null || true)"
if ! available "$selected"; then
  selected=
  for app in /Applications/Xcode*.app; do
    if available "$app/Contents/Developer"; then
      selected="$app/Contents/Developer"
      break
    fi
  done
fi
if [[ -z "$selected" ]]; then
  echo "No stable Xcode with the required $sdk SDK (26 or newer)" >&2
  exit 1
fi
printf 'DEVELOPER_DIR=%s\n' "$selected" >> "$GITHUB_ENV"
DEVELOPER_DIR="$selected" xcodebuild -version
