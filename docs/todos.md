# Todos

## P0 — Blocking for real-world use

- [x] **Worktree isolation**: Codex guests now use isolated git worktrees under `SALON_DIR/worktrees/<guest>` when the project is in git. Non-git projects still fall back to the shared workspace.
- [x] **Shell escaping**: tmux commands now go through `execFileSync`, guest names are validated, and launcher/wrapper scripts quote injected paths explicitly.
- [ ] **Preflight checks**: only tmux is verified at startup. Should check for pi, claude, codex, jq, nc and report missing dependencies clearly.

## P1 — Important for reliability

- [x] **Guest ready signal**: guest wrappers now emit `guest_ready` over the salon socket and messages queue until the guest reports ready.
- [ ] **Codex status detection**: `detectGuestStatus()` only has heuristics for Claude Code's TUI. Codex CLI patterns (spinner, prompt) are not implemented — most states fall through to "idle".
- [ ] **Consensus detection**: keyword matching ("agree", "no objection", etc.) is brittle. Consider LLM-based detection or asking guests to use a structured signal format.
- [ ] **Config backup/rollback**: hook installation modifies `~/.claude/settings.json` and `~/.codex/config.toml` without backup. Should save a backup before modifying and provide an uninstall command.
- [x] **Test environment isolation**: tests now explicitly clear inherited salon env vars when validating non-salon hook behavior.

## P2 — Scaling and UX

- [ ] **Pane layout for many guests**: tmux's pane model can't display 16+ guests meaningfully. Idle agents can't be "minimized" to a status line because tmux panes have a minimum height that breaks agent TUIs. Two approaches to explore:
  - **tmux window swapping**: move idle guests to a hidden window, show a status-only pane listing all guests. Select to swap back.
  - **Custom TUI dashboard**: a dedicated TUI program (ratatui, OpenTUI, or pi-tui) that manages guest display regions, collapsing idle guests to one line. This is an architectural shift away from tmux-native pane management.
- [x] **Discussion persistence**: salon snapshots now persist guest/discussion state via `pi.appendEntry()`, and host resume injects a recovered summary into the next host turn.
- [ ] **Session history / review UI**: no way to review past discussions. Consider exporting discussion transcripts as markdown.
- [x] **Multi-session support**: `SALON_INSTANCE`, `SALON_TMUX_SESSION`, and `SALON_DIR` are now parameterized so multiple salons can run side by side.

## P3 — Nice to have

- [ ] **Guest type auto-selection**: host currently chooses guest type manually. Could infer from the task description (code change → codex, analysis → claude).
- [ ] **Discussion templates**: pre-defined discussion patterns beyond the current explore → debate → synthesize flow (e.g., red team/blue team, pros/cons, implementation sprint).
- [ ] **Metrics**: track token usage, response times, discussion round counts per guest to inform host decisions.
