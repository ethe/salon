# Architecture

This document describes the internal architecture of salon for contributors. For usage and setup, see `README.md`. For contributor guidelines, see `CLAUDE.md`.

## System overview

Salon is a multi-agent collaboration tool that coordinates guest agents (Claude Code, Codex CLI) from a host agent, all running in tmux panes within a shared session.

```
┌─ tmux session ───────────────────────────────────────────┐
│ ┌─ pane 0 (host) ──────┐  ┌─ pane 1 (guest) ───────────┐ │
│ │ pi + extension.ts    │  │ claude / codex TUI         │ │
│ │                      │  │ (wrapper.sh → agent CLI)   │ │
│ │                      │  └────────────────────────────┘ │
│ │                      │  ┌─ pane 2 (guest) ───────────┐ │
│ │                      │  │ claude / codex TUI         │ │
│ └──────────────────────┘  └────────────────────────────┘ │
└──────────────────────────────────────────────────────────┘
```

**Components:**

- **Host** (`src/extension.ts`): A pi extension that registers tools (`invite_guest`, `say_to_guest`, `discuss`, etc.), manages guest lifecycle, and runs a Unix socket server for receiving guest responses.
- **Guests**: Claude Code or Codex CLI instances, each running in a tmux pane via a wrapper script that handles ready detection and exit reporting.
- **TmuxBackend** (`src/tmux-backend.ts`): Implements `GuestRuntime` — spawns panes, sends keystrokes, detects TUI status, manages layout.
- **Discussion engine** (`src/discussion.ts`): Pure state machine for structured multi-guest discussions. No I/O — returns command objects for the extension to dispatch.
- **Hook** (`hooks/agent-response.sh`): Bash script triggered by Claude Code's Stop hook or Codex CLI's notify mechanism. Extracts the agent's last response and sends it to the host via Unix socket.
- **Setup** (`src/setup.ts`): Post-install script that registers the hook in `~/.claude/settings.json` and `~/.codex/config.toml`.
- **Launcher** (`src/main.ts`): Entry point. Creates the tmux session, injects environment variables, launches the host agent, and attaches the terminal.

## Communication mechanisms

### Host → Guest: tmux send-keys

The host sends messages to guests by pasting text into their tmux pane via `tmux send-keys -l`, followed by the appropriate submit key (`Enter` for Claude Code, `C-m` for Codex CLI).

Implementation: `TmuxBackend.sendRaw()` (`src/tmux-backend.ts`). Messages are queued per-pane with a 200ms delay between the text paste and the submit key press, preventing the TUI from dropping input that arrives faster than it can process.

The message is prefixed with `[host]: ` (or `[<from>]: ` for cross-guest messages in discussions).

**Long message exchange**: Messages exceeding 2000 characters are written to `SALON_DIR/exchange/<counter>_<sender>.md`, and the guest receives `[host]: Read <path> and respond.` instead. Claude Code guests have the exchange directory added via `--add-dir` at launch so they can read these files. See `sayToGuestImpl()` in `src/extension.ts`.

**Message queuing**: If a guest hasn't reported ready yet, messages are buffered in `queuedGuestMessages` and flushed automatically when the guest becomes ready. This lets callers fire-and-forget messages immediately after `invite_guest`.

### Guest → Host: hook + Unix socket

When a guest agent completes a response:

1. Claude Code triggers its Stop hook; Codex CLI triggers its notify callback. Both invoke `hooks/agent-response.sh`.
2. The hook extracts `last_assistant_message` (Claude) or `last-assistant-message` (Codex) from the JSON payload.
3. The hook sends `{"from":"<guest_name>","content":"<response>"}` to `SALON_DIR/salon.sock` via `nc -U`.
4. The host's socket server (`startMessageServer()` in `src/extension.ts`) parses the JSON and dispatches it — either to the discussion engine or as a `followUp` message to the host agent.

**Safety guards in the hook:**
- `SALON_GUEST_NAME` must be set (skip in non-salon environments).
- Socket file must exist (skip if host isn't running).
- `stop_hook_active` field must not be true (prevents Claude Code infinite loops).
- Non-response Codex events (anything except `agent-turn-complete`) are skipped.

### System events via socket

The guest wrapper script (`buildWrapperScript()` in `src/tmux-backend.ts`) sends system events using the same socket, with `from: "_system"`:

- `guest_ready:<name>` — TUI has started and is accepting input.
- `guest_ready_timeout:<name>` — The outer startup loop timed out before the pane appeared to leave the shell and start the agent CLI.
- `guest_exited:<name>:<sessionId>` — Guest process exited; reports the known session ID when available, otherwise falls back to scraping resume commands from pane content.

### Status detection: tmux capture-pane

`TmuxBackend.getStatus()` captures pane content and scans the last 10 non-empty lines to determine guest state. All detection patterns are centralized in the `TUI_PATTERNS` constant (`src/tmux-backend.ts`):

| Status | Detection |
|--------|-----------|
| `working` | Claude Code spinner chars (✽ etc.) + ellipsis (…), or Codex braille spinner chars |
| `input` | "Esc to cancel" (permission prompt), `❯` followed by digit (selection menu), or `(y/n)` (Codex approval) |
| `idle` | None of the above matched |
| `new` | Pane has no content |

The host also maintains an `eventStatus` field per guest (`"working"` when a message is sent, `"idle"` when a response arrives via socket), which `getGuestDisplayStatus()` cross-references with pane status for more accurate reporting.

## Guest lifecycle

### State machine

```
inviteGuest()          resumeInactiveGuest()
     │                        │
     ▼                        ▼
 ┌────────────────┐  markGuestReady()  ┌────────────────┐
 │ active         │───────────────────→│ active         │◄────────┐
 │ (ready=false)  │                    │ (ready=true)   │         │
 └────────────────┘                    └───────┬────────┘         │
                                               │                  │
                              beginGuestDismissal()  resumeInactiveGuest()
                                               │                  │
                                               ▼                  │
                                         ┌───────────┐           │
                                         │dismissing │           │
                                         └─────┬─────┘           │
                                               │                 │
                                       guest_exited /            │
                                       teardown timeout          │
                                               │                 │
                                     ┌─────────┴──────────┐     │
                                     ▼                    ▼     │
                               ┌───────────┐      ┌───────────┐ │
                               │ dismissed │      │ suspended │─┘
                               │(user exit)│      │(host exit)│
                               └───────────┘      └───────────┘
```

`GuestLifecycleStatus` has four values: `active`, `dismissing`, `suspended`, `dismissed`. There is no separate "new" state — a freshly spawned guest is `active` with `ready = false`. The `ready` flag is orthogonal to lifecycle status and controls message queuing: messages sent before `ready = true` are buffered and flushed when `markGuestReady()` fires.

The distinction between `dismissed` and `suspended` depends on `teardownReason`: `"user"` (explicit dismiss) produces `dismissed`; `"host"` (host session ending) produces `suspended`. Suspended guests are auto-resumed when the host session restarts.

### Lifecycle transition helpers

Five helpers in `src/extension.ts` centralize all lifecycle side effects. `cancelCodexSessionScan()` is only called inside these helpers — never at external call sites.

- **`activateGuestLifecycle(guest, options)`** — Registers in `guests` map, claims session ID, clears message queue, writes runtime file. Used by both `invite_guest` and `resume_guest`.
- **`markGuestReady(name)`** — Sets `ready = true`, writes runtime file, flushes queued messages.
- **`transitionGuestToDismissing(guest, reason)`** — Captures Codex session ID (last chance before exit), cancels session scan, removes from discussion, persists state. Returns `false` if already dismissing.
- **`transitionGuestToInactive(name, sessionId, options)`** — Moves guest from `guests` to `dismissedGuests`, settles exit waiter, cleans up queued messages. Handles both active and already-inactive cases.
- **`trackGuestSessionId(guest, sessionId, options)`** — Consolidates the `guest.sessionId = ...; claimedSessionIds.add(...)` pattern used across multiple transitions.

### Ready detection

The wrapper script spawns a background "ready watcher" process with two phases:

1. **Outer loop** (up to 150 iterations × 0.2s ≈ 30s): Polls `tmux display-message #{pane_current_command}` until the pane process is no longer a shell (`bash`/`zsh`/`sh`) — meaning the agent CLI has started. If this loop expires without detecting a non-shell process, sends `guest_ready_timeout`.
2. **Inner loop** (up to 60 iterations × 0.5s = 30s): Once the CLI is detected, polls `tmux capture-pane` for prompt glyphs (`❯` or `› `). If the glyph is found, sends `guest_ready`. If the inner loop expires without finding a glyph, sends `guest_ready` anyway as a fallback — the CLI is running even if the prompt pattern wasn't detected.

This means `guest_ready_timeout` only fires when the agent CLI itself fails to start (outer loop). Once the CLI is running, `guest_ready` is always sent regardless of glyph detection success.

The two-phase approach is necessary: checking only for prompt glyphs would match the shell's own prompt before the agent starts; checking only for the process name wouldn't confirm the TUI is rendered.

## Discussion state machine

The discussion engine (`src/discussion.ts`) is a pure state machine. All I/O is performed by the caller (`dispatchDiscussionCommands()` in `src/extension.ts`) based on returned command objects.

```
       discuss tool
           │
           ▼
     ┌───────────┐  both respond   ┌──────────┐
     │ exploring  │───────────────→│ debating  │◄─── advance("continue")
     └───────────┘                 └─────┬─────┘
                                         │
                              advance("synthesize")
                                         │
                                         ▼
                                  ┌──────────────┐
                              ┌──→│ synthesizing  │──┐
                              │   └───────────────┘  │
                              │  submit_synthesis    │ finalize_discussion
                              │  (guests object)     │ (guests approve)
                              └──────────────────────┘
                                         │
                                         ▼
                                      ┌──────┐
                                      │ done │
                                      └──────┘
```

**Flow:**

1. **Exploring**: Both guests receive the same prompt and respond independently. When both have responded, their proposals are cross-sent and the stage advances to `debating`.
2. **Debating**: Each guest reviews the other's proposal. After each round, both responses are delivered to the host, who decides: `continue` (another round with optional guidance), `synthesize` (move on), or `ask_user` (escalate).
3. **Synthesizing**: The host writes a synthesis and calls `submit_synthesis`, which sends it to both guests for review.
4. **Done**: Either `finalize_discussion` (guests approved) or `ask_user` (escalated to user).

Discussions track rounds via `Discussion.rounds` (completed) and `Discussion.currentRound` (in progress). Each round is a `Map<guestName, response>`.

**Guest-discussion association**: `guestToDiscussion` maps guest names to discussion IDs. When a guest response arrives via socket, `handleDiscussionMessage()` checks this map to route it to the correct discussion. Unassociated messages are forwarded to the host.

**Archiving**: `cleanupDiscussion()` moves a discussion from `discussions` to `archivedDiscussions` and detaches both guests from the `guestToDiscussion` map. This is triggered by three paths: guest dismissal (`removeGuestFromDiscussion()`), `advance_discussion("ask_user")`, and `finalize_discussion`. Archived discussions with `stage !== "done"` can be reactivated by `reactivateArchivedDiscussions()` if both guests become active again (e.g., after resume).

## State persistence and recovery

### Snapshot mechanism

`persistSalonState()` serializes all guest records and discussions into a `SalonStateSnapshot` and appends it to the pi session via `pi.appendEntry()`. This snapshot includes both active and dismissed guests, and both active and archived discussions.

On session restore (`restoreSalonSession()`), the most recent snapshot is found by scanning entries backward. Guests that were `dismissed` in the snapshot remain `dismissed`; all others (including those that were `active` or `dismissing` when the host exited) become `suspended`. Then `autoResumeAllSuspendedGuests()` attempts to resume each suspended guest that has a saved session ID. Failures are collected and included in the recovery summary shown to the host.

### Runtime files

Each guest has a JSON file at `SALON_DIR/guests/<name>.json` containing `name`, `type`, `paneId`, `sessionId`, `nonce`, `startedAt`, and `workspaceDir`. These files serve as a secondary data source during restore (the snapshot is primary, but runtime files may have more recent session IDs captured just before exit).

### Message file counter

`restoreMsgFileCounter()` scans `SALON_DIR/exchange/` for the highest existing counter prefix to avoid filename collisions after resume.

### Auto-resume

Guests with `lifecycleStatus === "suspended"` and a saved `sessionId` are automatically resumed when the host restarts. Resume uses `claude --resume <sessionId>` or `codex resume <sessionId>`. Failures are reported in the recovery summary rather than silently swallowed.

## Codex session association

Codex CLI does not support pre-assigned session IDs (unlike Claude Code's `--session-id`). Salon discovers the session ID post-launch via two mechanisms:

### Nonce matching

At invite time, a unique nonce string (`SALON_NONCE:<8-hex-chars>`) is embedded in the guest's instructions file. After Codex starts, `scanCodexSessionId()` periodically scans `~/.codex/sessions/<year>/<month>/<day>/rollout-*.jsonl` files, reading only the first line (`session_meta` entry) of each. A candidate matches if its `base_instructions.text` contains the nonce.

### Directory scanning with startedAt anchor

`getCodexSessionDateDirs()` generates the date directories to scan based on the guest's `startedAt` timestamp (±1 day window to handle timezone mismatches and midnight boundaries). When `startedAt` is unknown (e.g., after a restore where timestamps were lost), `Date.now()` is used as a directory search heuristic — but `timestampDistanceMs` remains `Infinity` so it doesn't bias candidate ranking. This separation ensures the search casts a reasonable net without fabricating temporal precision.

### Candidate ranking

`isBetterCodexSessionCandidate()` ranks candidates by: nonce match > cwd match > timestamp distance > session ID (lexicographic tiebreaker). The scan runs on a 2-second interval with a 30-second timeout. Already-claimed session IDs are excluded.

### Exit-time capture

When the guest process exits, the wrapper script reports the session ID via the `guest_exited` system event. It first uses `options.initialSessionId` (pre-assigned for Claude Code guests at invite time). Only if that is empty does it fall back to scraping the pane content for `claude --resume <id>` or `codex resume <id>` patterns — this covers Codex guests whose session ID wasn't discovered by the periodic scan.

## Error handling strategy

### tmux command tiers

`runTmux()` in `src/tmux-backend.ts` supports two modes:

| Method | Mode | Behavior on failure |
|--------|------|---------------------|
| `tmuxStatusQuery()` | `tolerant` | Returns `""` — appropriate for `capture-pane`, `list-panes` (pane might be gone) |
| `tmuxControlQuery()` | `required` | Throws with stderr detail — for queries where the result drives control flow (`display-message`, `list-panes` in layout operations) |
| `tmuxCommand()` | `required` | Throws — for side effects (`send-keys`, `split-window`, `kill-session`) |

`tmuxErrorDetail()` extracts stderr from the error for diagnostic messages. `isTmuxMissingSessionError()` identifies "can't find session" errors so that `destroySession()` can tolerate already-destroyed sessions.

**Edge cases handled:**
- `beginGuestDismissal()`: If `interrupt()`/`terminate()` throws but the pane is dead (`!isAlive()`), settles the exit waiter instead of propagating the error.
- `drainSendQueue()`: `try/finally` around the submit key ensures the `sendActive` set is cleared even if tmux throws, preventing permanent queue stalls.
- `guest_exited` handler: `equalize()` wrapped in try/catch since the tmux session may already be shutting down.

### Socket conflict detection

`ensureSocketPathAvailable()` prevents multiple host instances from stomping each other:

1. Check if `host.pid` references a live process (`isProcessAlive()` using `process.kill(pid, 0)`).
2. Probe the socket with a connection attempt (`probeSocket()`) — `"listening"` (connected within 250ms), `"stale"` (refused, timeout, or not a socket), or `"missing"`.
3. Only unlink and recreate if stale or missing. Throw if an active instance is detected.

`host.pid` is written *after* the socket starts listening, and `closeSalonMessageServer()` only deletes the PID file if the current process owns it.

### Hook safety

`hooks/agent-response.sh` uses `set -euo pipefail` and guards against:
- Non-salon environments (`SALON_GUEST_NAME` unset → exit)
- Missing socket (host not running → exit)
- Claude Code re-entry loops (`stop_hook_active` field → exit)
- Non-response Codex events (`type !== "agent-turn-complete"` → exit)

## Host prompt and context injection

The host agent's behavior is shaped by two pi hooks that modify what the LLM sees each turn.

### `before_agent_start` — system prompt construction

Fires once when the agent session begins. The handler:

1. **Replaces pi's default identity** with the salon host preamble — a multi-section prompt that defines the host's role (facilitator, not developer), when to invite guests vs. use `discuss`, guest type characteristics, communication guidelines, and the discussion flow protocol.
2. **Injects the recovery summary** if the session was restored from a snapshot (`pendingResumeSummary`). This tells the host which guests are active, suspended, or failed to resume, and which discussions are in progress. The summary is consumed once and cleared.
3. **Preserves the rest of pi's system prompt** (tool descriptions, etc.) by appending it after the salon preamble.

This is why the host "knows" it shouldn't read source code, why it knows about recovered guests after a restart, and why it understands the discussion protocol — it's all in the system prompt, not learned from context.

### `context` — salon status injection

Fires before every LLM turn. The handler:

1. Strips any prior `salon-status` synthetic message from the context (prevents stale snapshots from accumulating).
2. Builds a fresh `[salon-status]...[/salon-status]` block listing each active guest's current display status (working, idle, input, starting, dismissing) and any active discussion stage.
3. Appends it as a non-displayed custom message.

This gives the host continuously updated awareness of guest states without requiring it to call `list_guests`. The message is invisible to the user but visible to the LLM.

## Session lifecycle hooks

The extension registers five pi session hooks that manage salon state across session boundaries:

| Hook | When it fires | What salon does |
|------|---------------|-----------------|
| `session_directory` | Pi asks where to store session data | Returns `SALON_DIR/host-sessions/` |
| `session_start` | Initial session begins | `restoreSalonSession()` + `openSalonMessageServer()` — restore state from snapshot, auto-resume suspended guests, start the Unix socket server |
| `session_switch` | User switches to a different session branch | Same as `session_start` — restore and reconnect |
| `session_before_switch` | About to switch away from current session | `teardownSalonSession({ killTmuxSession: false })` — gracefully dismiss all guests but keep the tmux session alive for potential reattach |
| `session_shutdown` | Host is shutting down | `teardownSalonSession({ killTmuxSession: true })` — dismiss all guests and destroy the tmux session |

The `teardownSalonSession` flow: send interrupt + terminate to each active guest, wait up to 5 seconds for exit events, force-transition any remaining `dismissing` guests to inactive, persist final state, close socket server.

## Workspace isolation

The README and docs reference git worktree isolation for Codex guests (`SALON_DIR/worktrees/<guest>`), but this feature is not present in the current source code. All guests currently share the host's working directory, passed as `workDir` to `runtime.spawn()`. The `workspaceDir` field on guest records tracks this per-guest for display and resume purposes.

## Key design decisions

### Why tmux send-keys instead of an agent SDK

Claude Code and Codex CLI are interactive TUI applications without a programmatic API for injecting prompts. `tmux send-keys` is the only mechanism that works with both tools without modification. The trade-off is coupling to TUI rendering details (prompt glyphs, spinner characters), which is mitigated by centralizing all detection patterns in `TUI_PATTERNS`.

### Why ready detection needs two-phase polling

A single check is insufficient:
- **Process name only**: The agent CLI has started, but the TUI may not have rendered yet. Sending keys at this point would be lost.
- **Prompt glyph only**: The shell's own prompt (e.g., `❯` in starship) would match before the agent even launches.

The two phases (wait for non-shell process → wait for prompt glyph) ensure the agent is both running and ready to accept input.

### Why TUI patterns are centralized

Spinner characters, prompt glyphs, and approval prompts are implementation details of Claude Code and Codex CLI that can change with any upstream release. `TUI_PATTERNS` in `src/tmux-backend.ts` provides a single location to update when this happens, rather than hunting through `getStatus()`, `buildWrapperScript()`, and potentially future detection code.

### Why lifecycle transitions are centralized in helpers

Before the refactor, `cancelCodexSessionScan()` was called at 5+ scattered locations, and the guest activation sequence (register in map, claim session ID, clear queue, write runtime file, persist) was duplicated across `inviteGuest()`, `resumeInactiveGuest()`, and the socket message handler. The five lifecycle helpers (`activateGuestLifecycle`, `markGuestReady`, `transitionGuestToDismissing`, `transitionGuestToInactive`, `trackGuestSessionId`) ensure that every state transition performs all required side effects without relying on callers to remember the correct sequence.

### Why the discussion engine is a pure state machine

`src/discussion.ts` performs no I/O. All functions mutate the `Discussion` in place and return `DiscussionCommand[]` arrays that the caller dispatches. This makes the discussion logic testable in isolation and keeps the I/O boundary explicit — the extension decides *how* to send messages and persist state, while the engine decides *what* to send and *when* to transition.
