# Salon

A multi-agent collaborative workspace where a host agent coordinates guest agents (Claude Code, Codex CLI) to solve problems through structured discussion.

## Why

Single-agent coding assistants have blind spots. When you ask one agent to design an architecture or plan a migration, you get one perspective — shaped by one model's biases. Salon makes it easy to get multiple independent perspectives on the same problem, have the agents critique each other's proposals, and converge on a better answer through debate.

Two concrete use cases:

1. **Structured discussion** — Two agents independently explore a design question, cross-review each other's proposals across multiple rounds until they reach consensus (or surface open questions for the user), and the host synthesizes the result.
2. **Delegated execution** — The host assigns a clear task to a single guest agent while the user continues working. The guest's result is automatically reported back.

### How salon differs from Agent Teams

Claude Code's [Agent Teams](https://code.claude.com/docs/en/agent-teams) is a built-in multi-agent feature where a lead Claude Code session spawns teammate Claude Code sessions that coordinate via a shared task list. Salon takes a different approach:

- **Cross-model collaboration**: Salon coordinates Claude Code *and* Codex CLI in the same session. Different models have genuinely different strengths — Claude tends toward analytical depth, Codex toward engineering rigor. Discussions between them surface perspectives that a single-model team cannot.
- **Structured debate protocol**: Agent Teams use free-form messaging and a shared task list. Salon's `discuss` tool enforces a specific flow — independent exploration → adversarial cross-review → host synthesis → guest confirmation — designed to extract disagreement rather than converge prematurely.
- **Host as facilitator, not lead worker**: In Agent Teams, the lead is also a Claude Code instance that assigns tasks and does work. In salon, the host is a distinct role that does not read code or make changes — it frames questions, facilitates discussion, and synthesizes results. This separation prevents the coordinator from anchoring the team's output.
- **Model-agnostic architecture**: Salon communicates with guests through tmux panes and Unix sockets, not Claude Code internals. Salon uses terminal automation and socket IPC rather than product-specific SDK internals, so it can be extended to other TUI agents with additional runtime and hook integration.

## How it works

Salon is a [pi](https://github.com/badlogic/pi-mono) extension. The host runs as a pi instance with salon tools; guests are standard Claude Code or Codex CLI processes running in tmux panes within the same session.

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

The host communicates with guests by sending messages into their TUI and receiving responses via a Unix socket. Messages are queued until a guest is ready, and long messages are exchanged through files. Guests respond automatically — the host never needs to poll. You can also switch to any guest's pane and interact with them directly.

### Structured discussion

The `discuss` tool orchestrates a multi-round debate between two guests:

1. **Explore** — Both guests receive the same question and respond independently.
2. **Debate** — Each guest reviews the other's proposal. After each round, the host decides: continue debating, move to synthesis, or escalate to the user.
3. **Synthesize** — The host writes a synthesis and submits it to both guests for confirmation.

Cross-review messages use the other guest's name as prefix (`[alice]:`, `[bob]:`), so each guest knows who they're responding to.

### Guest lifecycle

Guests go through: **spawn** → **ready** → **active** (working/idle) → **dismiss** or **suspend**. Suspended guests retain their session IDs and can be resumed with full conversation history. When the host session restarts, suspended guests are automatically resumed.

The host is a facilitator, not a developer — it does not read code or make changes directly. It frames questions, chooses which guests to involve, facilitates discussion, and synthesizes results.

For implementation details — IPC mechanisms, TUI status detection, state persistence, Codex session association, error handling — see [ARCHITECTURE.md](ARCHITECTURE.md).

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
