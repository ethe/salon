# Salon

A multi-agent collaborative workspace where a host agent coordinates guest agents (Claude Code, Codex CLI) to solve problems through structured discussion.

## Why

Single-agent coding assistants have blind spots. When you ask one agent to design an architecture or plan a migration, you get one perspective — shaped by one model's biases. Multi-agent tools like [Agent Teams](https://code.claude.com/docs/en/agent-teams) help by parallelizing work, but teammates still share the same model and coordinate through free-form messaging.

Salon takes a different approach: it pairs agents from *different* models (Claude Code and Codex CLI) and puts them through a structured debate protocol. Different models err in different directions — Claude tends toward analytical depth, Codex toward engineering rigor — so cross-review between them reliably surfaces blind spots that a single-model team would miss.

Two concrete use cases:

1. **Structured discussion** — Two agents independently explore a design question, cross-review each other's proposals across multiple rounds, and the host synthesizes the result.
2. **Delegated execution** — The host assigns a clear task to a single guest agent while the user continues working. The guest's result is automatically reported back.

## How it works

Salon is a [pi](https://github.com/badlogic/pi-mono) extension. It runs inside a tmux session: the host occupies one pane, and each guest agent (Claude Code or Codex CLI) gets its own pane.

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

The host is a facilitator — it does not read code or make changes directly. It understands the user's intent, chooses which guests to involve, frames questions, facilitates discussion, and synthesizes results. This separation means the coordinator never anchors the team's output with its own implementation bias.

Communication uses terminal automation and socket IPC: the host sends messages into each guest's TUI, and guests respond automatically through a hook that delivers their output back to the host. Messages are queued until a guest is ready, so callers can fire-and-forget immediately after inviting a guest. You can also switch to any guest's pane and interact with them directly — messages without a `[name]:` prefix stay private.

### Structured discussion

The `discuss` tool orchestrates a multi-round debate between two guests (by default, one Claude Code + one Codex CLI for cross-model perspective):

1. **Explore** — Both guests receive the same question and respond independently.
2. **Debate** — Each guest reviews the other's proposal and gives feedback. After each round, the host decides: continue debating, move to synthesis, or escalate to the user.
3. **Synthesize** — The host writes a synthesis and submits it to both guests for confirmation.

This flow is designed to extract disagreement rather than converge prematurely — guests must engage with the other's reasoning before the host can move on.

### Guest lifecycle

Guests go through: **spawn** → **ready** → **active** (working/idle) → **dismiss** or **suspend**. Suspended guests retain their session IDs and can be resumed with full conversation history. When the host session restarts, suspended guests are automatically resumed.

Because salon coordinates guests through tmux panes and Unix sockets rather than product-specific internals, it can be extended to other TUI-based coding agents with additional runtime and hook integration.

For implementation details — IPC mechanisms, TUI status detection, state persistence, Codex session association, error handling — see [ARCHITECTURE.md](ARCHITECTURE.md).

## Usage

```bash
# Install globally (once)
npm install && npm link    # or: npm install -g .

# Launch
salon [working-directory]
```

`npm install` registers hooks (idempotently) for Claude Code and Codex CLI. `salon` creates a tmux session and launches the host. If working inside the repo without a global install, `npm start -- [working-directory]` works as well.

Inside the host:

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
