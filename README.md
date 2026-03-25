# Salon

A multi-agent collaborative workspace where a host agent coordinates guest agents (Claude Code, Codex CLI) to solve problems through structured discussion.

## Why

Single-agent coding assistants have blind spots. When you ask one agent to design an architecture or plan a migration, you get one perspective — shaped by one model's biases. Salon makes it easy to get multiple independent perspectives on the same problem, have the agents critique each other's proposals, and converge on a better answer through debate.

Two concrete use cases:

1. **Structured discussion** — Two agents independently explore a design question, cross-review each other's proposals across multiple rounds until they reach consensus (or surface open questions for the user), and the host synthesizes the result.
2. **Delegated execution** — The host assigns a clear task to a single guest agent while the user continues working. The guest's result is automatically reported back.

## How it works

Salon is a [pi](https://github.com/badlogic/pi-mono) extension. The host runs as a pi instance with salon tools; guests are standard Claude Code or Codex CLI processes in tmux panes. For detailed internal architecture, see [ARCHITECTURE.md](ARCHITECTURE.md).

```
┌──────────────────────┬──────────────────────┐
│  Host (pi + salon)   │  Guest (Claude Code) │
│                      │                      │
│  understands intent  ├──────────────────────┤
│  coordinates guests  │  Guest (Codex CLI)   │
│  synthesizes results │                      │
└──────────────────────┴──────────────────────┘
      tmux session "salon-<instance>"
```

### Communication

```
Host → Guest:  tmux send-keys (simulates typing into guest's TUI)
Guest → Host:  Stop hook / notify → Unix domain socket (in-memory IPC)
```

- **Host to guest**: Messages are prefixed with `[host]:` so guests know the source. Long messages (>2000 chars) are written to `SALON_DIR/exchange/` and guests receive a file reference instead.
- **Guest to host**: Claude Code's Stop hook and Codex CLI's notify mechanism both call `hooks/agent-response.sh`, which extracts the response and sends it to the host's Unix socket server.
- **Human to guest**: The user can switch to any guest's tmux pane and type directly. Messages without a `[name]:` prefix are treated as private — they are not forwarded to the host.

### Discussion state machine

The `discuss` tool automates a multi-round debate:

```
Round 1 (exploring)
  Both guests receive the same question, explore independently.
      ↓ both respond
Round 2+ (debating)
  Each guest receives the other's response, gives feedback.
      ↓ both respond → host reviews
  ├─ advance_discussion("continue")   → another debate round
  ├─ advance_discussion("synthesize") → host writes synthesis
  └─ advance_discussion("ask_user")   → pause and escalate open questions

Synthesis
  Host submits synthesis to both guests for review.
      ↓ both respond
  ├─ finalize_discussion             → done
  └─ revise and submit_synthesis     → another synthesis review round
```

Cross-review messages use the other guest's name as prefix (`[alice]:`, `[bob]:`), so each guest knows who they're responding to.

### Guest lifecycle

- **Spawn**: `exec` replaces the shell process — when the agent exits, the tmux pane closes automatically.
- **Ready signal**: guests queue incoming messages until their wrapper reports `guest_ready` over the salon socket, so startup no longer depends on a fixed sleep.
- **Status detection**: `tmux capture-pane` inspects the TUI status bar to determine if a guest is working, waiting for input (approval), or idle. (Inspired by [gavraz/recon](https://github.com/gavraz/recon).)
- **Exit tracking**: the guest wrapper reports `guest_exited:<name>:<sessionId>` over the salon socket when the agent process terminates. The host automatically deregisters the guest and keeps its session/workspace metadata for resume.

### Session continuity

- **Host resume**: salon stores structured runtime state via `pi.appendEntry()` in a salon-specific host session directory and restores it on `pi --continue`.
- **Guest resume**: dismissed guests keep their session IDs and workspace paths. `resume_guest` relaunches the original Claude/Codex session when possible.
- **Recovered state injection**: after resume, the host receives a structured summary of recovered guests and discussions in its system prompt so it does not lose the salon's discussion state.
- **Session switching**: `/new` and `/resume` now dismiss active guests, persist the current salon state, and restore the target salon session after the switch.

### Guest system prompt injection

Guests receive salon context at the system prompt level, not as a chat message:

- **Claude Code**: `--append-system-prompt-file` + `--add-dir` for exchange directory access
- **Codex CLI**: `-c model_instructions_file="..."` + `C-m` as submit key (Codex treats `Enter` as newline)

The injected instructions are minimal — only the communication protocol (what `[name]:` prefixes mean), no personality changes.

### Host behavior

The host's system prompt defines it as a facilitator, not a developer:

- Does not read code or write implementations directly — delegates to guests
- Forwards user questions to guests as-is, without rewriting or decomposing
- For multi-guest discussions, always uses the `discuss` tool (never manual orchestration)
- Receives guest responses asynchronously via `followUp` delivery, no polling
- Synthesizes by identifying agreements, analyzing disagreements, and giving a recommendation with reasoning
- On resume, receives a structured summary of recovered guests/discussions before the next turn

## Usage

```bash
npm install
npm start [working-directory]
```

This creates a tmux session, installs hooks (idempotently) for Claude Code and Codex CLI, and launches the host. Inside the host:

- Talk naturally — the host decides when to involve guests
- `/discuss <topic>` — explicitly start a structured discussion
- `/guests` — list active guests and their status
- `/next` — jump to a guest waiting for approval
- `Ctrl-B + arrow` — switch to a guest pane for direct interaction

Optional environment variables:

- `SALON_INSTANCE` — override the derived salon instance ID
- `SALON_TMUX_SESSION` — override the tmux session name
- `SALON_DIR` — override the state/runtime directory

## Project structure

```
src/
  main.ts         Launcher: tmux session setup, hook installation, env forwarding
  extension.ts    Pi extension: tools, discussion state machine, IPC, host prompt
hooks/
  agent-response.sh   Unified hook for Claude Code (stdin) and Codex CLI ($1 arg)
test/
  e2e.ts          End-to-end tests: hook IPC, tmux pane management, send-keys, ready wrapper
ARCHITECTURE.md   Internal architecture documentation for contributors
```

## External configuration

Salon installs hooks into existing agent configs (idempotent, additive):

- `~/.claude/settings.json` — Stop hook → `agent-response.sh`
- `~/.codex/config.toml` — `notify` → `agent-response.sh`
