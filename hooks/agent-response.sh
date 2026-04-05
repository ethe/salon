#!/usr/bin/env bash
# Salon: unified hook for guest agent responses.
# Works with both Claude Code (JSON on stdin) and Codex CLI (JSON as $1).
# Sends response to host via Unix domain socket (in-memory IPC).

set -euo pipefail

# Only activate for salon guests
if [[ -z "${SALON_GUEST_NAME:-}" ]]; then exit 0; fi

if [[ -z "${SALON_DIR:-}" ]]; then exit 0; fi
SOCK="$SALON_DIR/salon.sock"
FORWARD_DIR="$SALON_DIR/forward/$SALON_GUEST_NAME"
ARMED_PATH="$FORWARD_DIR/armed"
FORWARD_PREFIX_PATTERN='^\[[A-Za-z0-9._-]+\]:[[:space:]]'

# No socket = host not running
if [[ ! -S "$SOCK" ]]; then exit 0; fi

# Read input: Codex passes JSON as $1, Claude Code passes on stdin
if [[ -n "${1:-}" ]]; then
	INPUT="$1"
else
	INPUT=$(cat)
fi

if [[ -z "$INPUT" ]]; then exit 0; fi

matches_forward_prefix() {
	local prompt="$1"
	printf "%s" "$prompt" | grep -Eq "$FORWARD_PREFIX_PATTERN"
}

next_ticket_path() {
	if [[ ! -d "$FORWARD_DIR" ]]; then
		return 1
	fi
	while IFS= read -r ticket_path; do
		printf "%s\n" "$ticket_path"
		return 0
	done < <(find "$FORWARD_DIR" -maxdepth 1 -type f -name "ticket-*" -print 2>/dev/null | LC_ALL=C sort)
	return 1
}

claim_ticket_as_armed() {
	local ticket_path
	ticket_path=$(next_ticket_path) || return 1
	mkdir -p "$FORWARD_DIR"
	rm -f "$ARMED_PATH"
	mv "$ticket_path" "$ARMED_PATH"
}

consume_next_ticket() {
	local ticket_path
	ticket_path=$(next_ticket_path) || return 1
	rm -f "$ticket_path"
}

send_to_host() {
	local response="$1"
	printf '{"from":"%s","content":%s}' "$SALON_GUEST_NAME" "$(printf "%s" "$response" | jq -Rs .)" \
		| nc -U "$SOCK" 2>/dev/null || true
}

extract_codex_last_user_input() {
	printf "%s" "$INPUT" | jq -r '
		def flatten_text:
			if type == "string" then .
			elif type == "array" then map(flatten_text) | join("")
			elif type == "object" then
				(.text // .input_text // .content // .message // "")
				| flatten_text
			else "" end;
		def extract_object_message:
			(.content // .message // .prompt // "")
			| flatten_text;
		(
			(.["input-messages"] // .input_messages // []) as $messages
			| if ($messages | type) == "string" then
				$messages
			elif ($messages | type) != "array" then
				empty
			elif ($messages | all(.[]?; type == "string")) then
				$messages[-1]?
			else
				(
					$messages
					| map(select(type == "object" and (.role // "") == "user"))
					| .[-1]?
					| extract_object_message
				)
			end
		) // empty
	'
}

EVENT_TYPE=$(printf "%s" "$INPUT" | jq -r '.type // empty')
if [[ -n "$EVENT_TYPE" ]]; then
	# Codex CLI notify payload — accept both turn-complete and task-complete
	case "$EVENT_TYPE" in
		agent-turn-complete|task-complete|task_complete) ;;
		*) exit 0 ;;
	esac

	# Field name varies: agent-turn-complete uses "last-assistant-message",
	# task-complete uses "last-agent-message" or "last_agent_message"
	LAST_MESSAGE=$(printf "%s" "$INPUT" | jq -r '
		.["last-assistant-message"]
		// .["last-agent-message"]
		// .["last_agent_message"]
		// .["last_assistant_message"]
		// empty')
	if [[ -z "$LAST_MESSAGE" ]]; then exit 0; fi

	LAST_USER_INPUT=$(extract_codex_last_user_input)
	if ! matches_forward_prefix "$LAST_USER_INPUT"; then exit 0; fi
	if ! consume_next_ticket; then exit 0; fi

	send_to_host "$LAST_MESSAGE"
	exit 0
fi

# Claude Code hook payload
CLAUDE_EVENT=$(printf "%s" "$INPUT" | jq -r '.hook_event_name // .event_name // empty')
if [[ "$CLAUDE_EVENT" == "UserPromptSubmit" ]]; then
	if [[ -e "$ARMED_PATH" ]]; then exit 0; fi
	PROMPT=$(printf "%s" "$INPUT" | jq -r '.prompt // empty')
	if [[ -z "$PROMPT" ]]; then exit 0; fi
	if ! matches_forward_prefix "$PROMPT"; then exit 0; fi
	claim_ticket_as_armed || exit 0
	exit 0
fi

# Prevent Claude Code infinite loops
STOP_HOOK_ACTIVE=$(printf "%s" "$INPUT" | jq -r '.stop_hook_active // false')
if [[ "$STOP_HOOK_ACTIVE" == "true" ]]; then exit 0; fi

if [[ -n "$CLAUDE_EVENT" && "$CLAUDE_EVENT" != "Stop" ]]; then exit 0; fi
if [[ ! -e "$ARMED_PATH" ]]; then exit 0; fi

LAST_MESSAGE=$(printf "%s" "$INPUT" | jq -r '.last_assistant_message // empty')
rm -f "$ARMED_PATH"
if [[ -z "$LAST_MESSAGE" ]]; then exit 0; fi

send_to_host "$LAST_MESSAGE"

exit 0
