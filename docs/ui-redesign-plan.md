# Salon UI/UX Redesign Plan

> From "exposing runtime" to "exposing orchestration."

## Problem statement

The current tmux multi-pane model is fundamentally a **debug/operator UI**:

- **Cognitive overload**: Users must monitor multiple streams and decide where to look. They become their own dispatchers — which contradicts the host's purpose as orchestrator.
- **Leaking implementation details**: Users perceive tmux panes, not a collaboration product.
- **Poor space utilization**: Adding more agents makes each pane too narrow to read. Information density drops as concurrency rises.
- **Fragmented conversation**: Host chat, guest chat, and task progress are scattered across panes with no unified narrative.

## Core design direction

**tmux continues as the runtime isolation layer, but stops being the primary UX.** The default experience shifts from multi-pane grid to unified channel with on-demand drill-down.

One-liner: **upgrade salon from "tmux pane manager" to "agent workspace" — tmux is the layer underneath, not the layer the user sees.**

## Three-layer architecture

### 1. Channel (main view) — pi chat stream

The user faces a single conversation flow by default.

- Talk to host directly (default)
- `@guest` to address a specific agent — routed to `say_to_guest`
- Guest responses appear inline in the stream
- Host orchestration decisions, status updates, and synthesized conclusions all live here
- The user is both **commander** (dispatching tasks) and **participant** (joining group discussions) — not just a spectator

### 2. Status layer — tmux status bar + injected status messages

Persistent awareness of parallel work without pane-watching.

- **Status bar chips**: `Euclid * working | Pythagoras * testing | Gauss . idle`
- **Color coding**: green = idle, yellow = working, red = needs attention
- **Event push**: Key events surfaced in the main channel (completion, blocking, errors)
- **Data source (short-term)**: spinner-level detection from `getStatus()` — working/idle/input
- **Data source (long-term)**: semantic progress events when guest-side hooks become available

### 3. Inspector (escape hatch) — tmux display-popup / on-demand pane

For debugging, long-task monitoring, direct intervention, and fault recovery.

- `peek <guest>` opens a tmux `display-popup` overlay showing guest's raw pane output
- User can still switch to a guest pane directly when needed
- This is the **advanced/diagnostic mode**, not the regular workflow

## Key design decisions

### Guest panes: retained but hidden by default

Pane value is real — debugging stuck agents, direct steering, fault recovery, monitoring long tasks. But these are minority scenarios. Default hidden + peek on demand preserves capability without polluting the main experience.

### @guest is addressing, not parallelism awareness

`@guest` solves "who am I talking to" but does not solve "is parallel work happening." The latter requires the status bar + event push. Both are necessary; neither alone is sufficient.

### Attention routing is the prerequisite for hiding panes

If a guest is stuck on a permission prompt or hits an error, the user must be able to detect and handle it from the main channel. Without this, hiding panes is unsafe.

- **Phase 1 mitigation**: `peek` serves as the manual safety valve. User notices `input` status on status bar, peeks to handle it.
- **Phase 3 upgrade**: Proactive forwarding — permission prompts and errors automatically surface in the host channel for resolution without pane switching.

### discuss becomes one mode within the channel, not the only multi-agent interaction

The current `discuss` state machine (two guests debate, user watches, user calls `advance_discussion`) remains valuable for structured convergence. But in the channel model, freeform group chat — where user, host, and multiple guests all participate in one stream — becomes the more natural default interaction for multi-agent work.

### Host remains the default entry point and primary orchestrator

`@guest` does not flatten the hierarchy. The host still mediates most interactions, makes orchestration decisions, and synthesizes results. Direct `@guest` is a shortcut, not a replacement for host-mediated collaboration.

## Technical constraints

### What the extension can control

| Mechanism | Use |
|-----------|-----|
| tmux status bar | Guest status chips (fully programmable) |
| tmux `display-popup` | Peek/inspect overlay |
| Injected messages | Status updates, formatted summaries in host stream |
| tmux layout | Pane visibility and sizing |

### What the extension cannot control

- Pi's rendering engine (no custom widgets inside the chat)
- Inline interactivity (no expandable cards, clickable elements)
- Collapsible sections or thread UI within the chat stream

### Semantic work state: a staged capability

| Level | Example | Data source | Feasibility |
|-------|---------|-------------|-------------|
| Lifecycle | working / idle / input | TUI pattern matching (`getStatus()`) | Available now |
| Host-visible semantics | dispatched / started / completed / blocked | Host's own orchestration events | Available now |
| Guest-internal semantics | "reading src/auth.ts" / "running tests: 3/10" | Guest-side intermediate hooks | Not available — depends on Claude Code / Codex exposing mid-turn events |

**Short-term: lifecycle + host-visible semantics only. Guest-internal semantics deferred until guest-side hooks mature.**

## Implementation roadmap

Each phase is independently valuable. Later phases do not block earlier ones.

### Phase 1: Hide + @guest + Peek

> "You can still see everything — you just don't have to."

- Guest panes spawn in background (hidden from default view)
- Host pane occupies full terminal width
- `@guest` syntax in user input routes to `say_to_guest`
- `peek <guest>` opens `tmux display-popup` showing guest's raw pane
- Guest responses continue flowing to host via existing socket IPC (no change)

**Key implementation questions:**
- How to hide guest panes? Options: spawn in a separate tmux window, or minimize pane size to zero.
- How to intercept `@guest` in user input? Pi extension hook on user message, or host prompt instruction.
- display-popup sizing and keybinding for dismiss.

### Phase 2: Status bar

> Persistent parallel-work awareness.

- tmux status bar updated with per-guest status chips
- Status derived from existing `getStatus()` (working/idle/input)
- Color coding: green (idle), yellow (working), red (needs attention)
- Status refreshed on a polling interval or triggered by state changes

**Key implementation questions:**
- Status bar refresh mechanism (tmux `status-interval` vs event-driven update).
- How to handle many guests (status bar overflow).

### Phase 3: Attention routing

> Making hidden panes safe.

- Guest permission prompts (`(y/n)`, tool approval) detected and forwarded to host channel
- Errors and blocking states forwarded as actionable notifications
- User can approve/deny from host channel without pane switching
- Extends existing `getStatus()` detection — when status = `input`, extract the prompt content and surface it

**Key implementation questions:**
- How to extract the actual prompt content from guest pane (not just detect `input` status).
- How to send approval back (simulate keypress in guest pane from host).
- Latency: polling-based detection may have noticeable delay.

### Phase 4: Semantic progress

> Deferred — depends on external conditions.

- When guest-side hooks expose intermediate events (tool calls, file reads, test runs), inject semantic progress into host channel
- "Euclid is editing src/auth.ts", "Pythagoras: tests 7/10 passed"
- Enables task-card-like status without custom UI — just structured messages in the chat stream

**Prerequisite:** Claude Code and/or Codex ship intermediate event hooks.

## Design references

| Source | What to borrow |
|--------|---------------|
| Slack | @mention addressing, main channel mental model, presence/status indicators |
| Linear | Task status flow, clear ownership, async collaboration feel |
| GitHub PRs | Artifact-centered discussion, diff/review/resolve patterns |
| Copilot Workspace | Plan -> execute -> output -> review task workflow |
| IRC + bots | Single channel, bot responds to triggers — the simplest valid model |

The target is not any one of these, but a terminal-native hybrid: **a group chat where some participants are AI agents, with structured task tracking and on-demand deep inspection.**
