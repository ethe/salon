#!/usr/bin/env bash
# Salon: unified hook for guest agent responses.
# Works with both Claude Code (JSON on stdin) and Codex CLI (JSON as $1).
# Sends response to host via Unix domain socket (in-memory IPC).

set -euo pipefail

# Only activate for salon guests
if [[ -z "${SALON_GUEST_NAME:-}" ]]; then exit 0; fi

SALON_DIR="${SALON_DIR:-/tmp/salon}"
SOCK="$SALON_DIR/salon.sock"

# No socket = host not running
if [[ ! -S "$SOCK" ]]; then exit 0; fi

# Read input: Codex passes JSON as $1, Claude Code passes on stdin
if [[ -n "${1:-}" ]]; then
    INPUT="$1"
else
    INPUT=$(cat)
fi

if [[ -z "$INPUT" ]]; then exit 0; fi

# Skip non-response events (Codex sends multiple event types)
EVENT_TYPE=$(echo "$INPUT" | jq -r '.type // empty')
if [[ -n "$EVENT_TYPE" && "$EVENT_TYPE" != "agent-turn-complete" ]]; then exit 0; fi

# Prevent Claude Code infinite loops
STOP_HOOK_ACTIVE=$(echo "$INPUT" | jq -r '.stop_hook_active // false')
if [[ "$STOP_HOOK_ACTIVE" == "true" ]]; then exit 0; fi

# Extract response — Claude uses last_assistant_message, Codex uses last-assistant-message
LAST_MESSAGE=$(echo "$INPUT" | jq -r '.last_assistant_message // .["last-assistant-message"] // empty')
if [[ -z "$LAST_MESSAGE" ]]; then exit 0; fi

# Send to host via Unix socket (nc -U for raw socket, pipe JSON and close)
printf '{"from":"%s","content":%s}' "$SALON_GUEST_NAME" "$(printf '%s' "$LAST_MESSAGE" | jq -Rs .)" \
    | nc -U "$SOCK" 2>/dev/null || true

exit 0
