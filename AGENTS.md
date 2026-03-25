# AGENTS.md

This file is for AI agents contributing to this repository. For product overview, architecture, workflow, and user-facing usage, see `README.md` and `ARCHITECTURE.md`.

## Core commands

```bash
npm install
npm run build
npm test
```

- `npm test` requires `tmux`.
- Run `npm test` after changes to hooks, guest lifecycle logic, discussion flow, or resume behavior.
- Run `npm run build` to type-check. The project runs via `tsx` at dev time, so build failures will not surface until you check explicitly.

## Code conventions

- Use tabs for indentation.
- Use double quotes.
- The project uses ES modules (`"type": "module"` in `package.json`). Use `import`, not `require`.
- TypeScript strict mode is enabled. Do not use `any` unless it is genuinely unavoidable, and handle `null` / `undefined` explicitly.
- No linter or formatter is configured. Follow the conventions above and match the style of surrounding code.
- Do not interpolate shell-bound values directly into command strings.
- Escape shell values with `shellQuote()` or `joinShellArgs()`.
- Validate guest names with `sanitizeGuestName()`.
- Invoke tmux via `execFileSync("tmux", args)`, not ad-hoc shell string construction.
- In `src/tmux-backend.ts`, use the semantic wrappers:
  - `tmuxStatusQuery()` for tolerant status queries
  - `tmuxControlQuery()` for control-flow queries that must throw on failure
  - `tmuxCommand()` for side-effecting tmux commands that must throw on failure
- Do not call the low-level `runTmux()` helper directly from new code.
- Keep the `__test__` export in `src/extension.ts`; the test suite depends on it.

## Change-specific checks

- If you change `src/extension.ts`, run `npm test`.
- If you change `src/tmux-backend.ts`, run `npm test`.
- If you change `hooks/agent-response.sh`, make sure the hook-related e2e coverage still passes, especially tests 4–7 in `test/e2e.ts`.
- Prefer not to commit code changes unless the relevant build/test commands pass locally.

## Side effects and pitfalls

- Running the project updates `~/.claude/settings.json` and `~/.codex/config.toml` in an additive, idempotent way.
- There is currently no backup or rollback for those config edits.
- Tests create temporary tmux sessions and temporary directories under `/tmp`.
- Do not commit local or generated artifacts such as `.claude/`, `dist/`, or `node_modules/`.

## Commit guidance

- Use short English semantic commit messages when possible, such as `docs: ...`, `fix: ...`, or `chore: ...`.
- Keep one logical change per commit.
