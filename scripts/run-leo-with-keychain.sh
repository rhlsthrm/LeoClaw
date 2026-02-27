#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KEYCHAIN_SERVICE="${LEO_KEYCHAIN_SERVICE:-leoclaw.telegram_bot_token}"
KEYCHAIN_ACCOUNT="${LEO_KEYCHAIN_ACCOUNT:-${USER:-${LOGNAME:-$(whoami)}}}"

if [[ -z "${TELEGRAM_BOT_TOKEN:-}" ]]; then
  TELEGRAM_BOT_TOKEN="$(security find-generic-password -a "$KEYCHAIN_ACCOUNT" -s "$KEYCHAIN_SERVICE" -w)"
  export TELEGRAM_BOT_TOKEN
fi

if [[ -z "${TELEGRAM_BOT_TOKEN:-}" ]]; then
  echo "Telegram bot token not found."
  echo "Add it with: security add-generic-password -a \"$KEYCHAIN_ACCOUNT\" -s \"$KEYCHAIN_SERVICE\" -w '<token>' -U"
  exit 1
fi

export AGENT_BROWSER_PROFILE="$ROOT_DIR/workspace/secrets/browser-profile"

cd "$ROOT_DIR"
exec node dist/index.js
