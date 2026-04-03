/**
 * Tmux-backed implementations of salon runtime interfaces.
 *
 * - TmuxLauncher: session bootstrap (create, attach, env, host launch)
 * - TmuxBackend: guest-level operations (spawn, send, status, focus)
 */

import { execFileSync } from "node:child_process";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GuestRuntime, GuestStatus, RuntimeSpawnOptions, SalonLauncher } from "./runtime.js";

// ── TUI detection patterns ────────────────────────────────────────────
// Centralized so that upstream TUI changes only require edits here.
const TUI_PATTERNS = {
	// Characters whose presence as the first char (with "…" elsewhere) indicates Claude Code is working.
	claudeSpinnerChars: "\u273D\u2722\u2733\u2736\u23FA\u2726\u2727\u2728\u2729\u272A\u272B\u272C\u272D\u272E\u272F\u2730\u2731\u2732\u2734\u2735\u2737\u2738\u2739\u273A\u273B\u273C",
	// Braille spinner characters used by Codex CLI while working.
	codexSpinnerChars: "\u280B\u2819\u2839\u2838\u283C\u2834\u2826\u2827\u2807\u280F",
	// Ellipsis accompanying Claude Code spinner lines.
	ellipsis: "\u2026",
	// Claude Code selection menu glyph (followed by a digit = approval menu).
	selectionMenuGlyph: "\u276F",
	// Text on the bottom bar of a Claude Code permission prompt.
	permissionPromptText: "Esc to cancel",
	// Codex CLI approval prompt pattern.
	approvalPromptPattern: /\(y\/n\)/i,
	// Extended regex for grep -qE in the bash ready-watcher script.
	readyPromptGrepPattern: "\u276F|\u203A ",
} as const;

/** Tmux user option storing the salon display name for a pane (used in border labels). */
const SALON_NAME_OPTION = "@salon_name";

/**
 * grep -E pattern that selects only salon-managed variables from
 * `tmux show-environment -s` output, preventing unrelated inherited
 * variables (e.g. npm_config_prefix) from leaking into pane shells while
 * keeping terminal capability metadata that host/guest TUIs depend on.
 *
 * Must stay in sync with the keys set by buildEnvironment() in main.ts.
 */
const SALON_ENV_FILTER = "^(SALON_|ANTHROPIC_API_KEY=|OPENAI_API_KEY=|https?_proxy=|HTTPS?_PROXY=|no_proxy=|NO_PROXY=|ALL_PROXY=|all_proxy=|COLORTERM=|TERM_PROGRAM=|TERM_PROGRAM_VERSION=|KITTY_WINDOW_ID=|GHOSTTY_RESOURCES_DIR=|WEZTERM_PANE=|ITERM_SESSION_ID=|WT_SESSION=|LC_TERMINAL=|LC_TERMINAL_VERSION=)";

/** Build a shell snippet that evals only salon-managed env vars from the tmux session. */
function filteredEnvEval(tmuxSession: string): string {
	return `eval "$(tmux show-environment -t ${shellQuote(tmuxSession)} -s | grep -E ${shellQuote(SALON_ENV_FILTER)})"`;
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function nonInteractiveBashCommand(script: string): string {
	return `bash --noprofile --norc -c ${shellQuote(script)}`;
}

function submitKeyForGuestType(type: "claude" | "codex"): string {
	return type === "codex" ? "C-m" : "Enter";
}

function terminateCommandForGuestType(type: "claude" | "codex"): string {
	return type === "claude" ? "/exit" : "exit";
}

function tmuxErrorDetail(error: unknown): string {
	if (!(error instanceof Error)) return String(error);
	const execError = error as Error & { stderr?: Buffer | string };
	const stderr = typeof execError.stderr === "string"
		? execError.stderr.trim()
		: Buffer.isBuffer(execError.stderr)
			? execError.stderr.toString("utf-8").trim()
			: "";
	return stderr || error.message;
}

function isTmuxMissingSessionError(error: unknown): boolean {
	return tmuxErrorDetail(error).toLowerCase().includes("can't find session");
}

function runTmux(args: string[], mode: "required" | "tolerant"): string {
	try {
		return execFileSync("tmux", args, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
	} catch (error) {
		if (mode === "tolerant") return "";
		const detail = tmuxErrorDetail(error);
		throw new Error(`tmux ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`);
	}
}

export class TmuxBackend implements GuestRuntime {
	private readonly tmuxSession: string;

	/** Per-pane async send queue: TUI apps need time to process pasted text before the submit key. */
	private readonly sendQueues = new Map<string, Array<{ text: string; submitKey: string }>>();
	private readonly sendActive = new Set<string>();

	/** Maps runtimeId → submit key so callers don't need to know transport details. */
	private readonly submitKeys = new Map<string, string>();

	constructor(tmuxSession: string) {
		this.tmuxSession = tmuxSession;
	}

	// ── GuestRuntime implementation ──────────────────────────────────

	spawn(options: RuntimeSpawnOptions): string {
		const wrapperScript = join(options.salonDir, "guests", `${options.name}.wrapper.sh`);
		writeFileSync(wrapperScript, this.buildWrapperScript(options));
		chmodSync(wrapperScript, 0o755);

		// Launch the wrapper directly as a non-interactive command so zsh init
		// (and prompt plugins such as p10k) never sees guest startup output.
		const runtimeId = this.spawnPane(options.workDir, this.buildGuestPaneCommand(wrapperScript));
		if (!runtimeId) throw new Error("Failed to create tmux pane");

		this.tmuxCommand(["set-option", "-p", "-t", runtimeId, SALON_NAME_OPTION, options.name]);

		const submitKey = submitKeyForGuestType(options.guestType);
		this.submitKeys.set(runtimeId, submitKey);

		return runtimeId;
	}

	send(runtimeId: string, text: string): void {
		const submitKey = this.submitKeys.get(runtimeId);
		if (!submitKey) throw new Error(`No submit key registered for runtime '${runtimeId}'. Was spawn() called?`);
		this.sendRaw(runtimeId, text, submitKey);
	}

	interrupt(runtimeId: string): void {
		this.tmuxCommand(["send-keys", "-t", runtimeId, "C-c"]);
		this.tmuxCommand(["send-keys", "-t", runtimeId, "C-c"]);
	}

	terminate(runtimeId: string, guestType: "claude" | "codex"): void {
		this.tmuxCommand(["send-keys", "-t", runtimeId, "-l", terminateCommandForGuestType(guestType)]);
		this.tmuxCommand(["send-keys", "-t", runtimeId, "Enter"]);
	}

	getStatus(runtimeId: string): GuestStatus {
		const content = this.tmuxStatusQuery(["capture-pane", "-t", runtimeId, "-p"]);
		if (!content) return "new";

		let linesChecked = 0;
		const lines = content.split("\n");
		for (let i = lines.length - 1; i >= 0; i--) {
			const trimmed = lines[i].trim();
			if (!trimmed) continue;

			// Input: permission prompt (Claude Code)
			if (linesChecked === 0 && trimmed.includes(TUI_PATTERNS.permissionPromptText)) {
				return "input";
			}

			// Working: spinner characters with ellipsis (Claude Code)
			const first = trimmed.charAt(0);
			if (TUI_PATTERNS.claudeSpinnerChars.includes(first) && trimmed.includes(TUI_PATTERNS.ellipsis)) {
				return "working";
			}

			// Working: braille spinner (Codex CLI)
			if (TUI_PATTERNS.codexSpinnerChars.includes(first)) {
				return "working";
			}

			// Input: selection menu "❯ N." (Claude Code approval)
			const idx = trimmed.indexOf(TUI_PATTERNS.selectionMenuGlyph);
			if (idx >= 0) {
				const after = trimmed.slice(idx + 1).trimStart();
				if (/^\d/.test(after)) return "input";
			}

			// Input: approval prompt (Codex CLI)
			if (linesChecked === 0 && TUI_PATTERNS.approvalPromptPattern.test(trimmed)) {
				return "input";
			}

			linesChecked++;
			if (linesChecked >= 10) break;
		}

		return "idle";
	}

	isAlive(runtimeId: string): boolean {
		return this.listAliveBestEffort().includes(runtimeId);
	}

	focus(runtimeId: string): void {
		this.tmuxCommand(["select-pane", "-t", runtimeId]);
	}

	equalize(): void {
		const panes = this.listAliveRequired();
		if (panes.length <= 1) return;
		const totalWidth = this.tmuxControlQuery(["display-message", "-t", `${this.tmuxSession}:0`, "-p", "#{window_width}"]);
		const width = Number(totalWidth);
		if (!Number.isFinite(width) || width <= 0) {
			throw new Error(`Invalid tmux window width '${totalWidth}' for session '${this.tmuxSession}'.`);
		}
		const halfWidth = Math.floor(width / 2);
		this.tmuxCommand(["set-option", "-t", `${this.tmuxSession}:0`, "main-pane-width", String(halfWidth)]);
		this.tmuxCommand(["select-layout", "-t", `${this.tmuxSession}:0`, "main-vertical"]);
		this.tmuxCommand(["select-pane", "-t", `${this.tmuxSession}:0.0`]);
	}

	destroySession(): void {
		try {
			this.tmuxCommand(["kill-session", "-t", this.tmuxSession]);
		} catch (error) {
			if (isTmuxMissingSessionError(error)) return;
			throw error;
		}
	}

	// ── Internal helpers ─────────────────────────────────────────────

	private listAliveRequired(): string[] {
		return this.tmuxControlQuery(["list-panes", "-t", `${this.tmuxSession}:0`, "-F", "#{pane_id}"]).split("\n").filter(Boolean);
	}

	private listAliveBestEffort(): string[] {
		return this.tmuxStatusQuery(["list-panes", "-t", `${this.tmuxSession}:0`, "-F", "#{pane_id}"]).split("\n").filter(Boolean);
	}

	private tmuxStatusQuery(args: string[]): string {
		return runTmux(args, "tolerant");
	}

	private tmuxControlQuery(args: string[]): string {
		return runTmux(args, "required");
	}

	private tmuxCommand(args: string[]): string {
		return runTmux(args, "required");
	}

	private buildGuestPaneCommand(wrapperScript: string): string {
		return nonInteractiveBashCommand(`exec bash ${shellQuote(wrapperScript)}`);
	}

	private spawnPane(workDir: string, command?: string): string {
		const panes = this.listAliveRequired();
		let newPaneId: string;
		if (panes.length <= 1) {
			const args = ["split-window", "-h", "-t", `${this.tmuxSession}:0.0`, "-p", "50", "-c", workDir, "-P", "-F", "#{pane_id}"];
			if (command) args.push(command);
			newPaneId = this.tmuxCommand(args);
		} else {
			const lastPane = panes[panes.length - 1];
			const args = ["split-window", "-v", "-t", lastPane, "-c", workDir, "-P", "-F", "#{pane_id}"];
			if (command) args.push(command);
			newPaneId = this.tmuxCommand(args);
		}
		this.equalize();
		return newPaneId;
	}

	private sendRaw(paneId: string, text: string, submitKey: string): void {
		const queue = this.sendQueues.get(paneId) || [];
		queue.push({ text, submitKey });
		this.sendQueues.set(paneId, queue);
		this.drainSendQueue(paneId);
	}

	private exitCopyModeIfNeeded(paneId: string): void {
		const inMode = this.tmuxStatusQuery(["display-message", "-t", paneId, "-p", "#{pane_in_mode}"]);
		if (inMode === "1") {
			this.tmuxCommand(["send-keys", "-X", "-t", paneId, "cancel"]);
		}
	}

	private drainSendQueue(paneId: string): void {
		if (this.sendActive.has(paneId)) return;
		const queue = this.sendQueues.get(paneId);
		if (!queue?.length) {
			this.sendQueues.delete(paneId);
			return;
		}

		this.exitCopyModeIfNeeded(paneId);
		this.sendActive.add(paneId);
		const item = queue.shift()!;
		this.tmuxCommand(["send-keys", "-l", "-t", paneId, item.text]);
		setTimeout(() => {
			try {
				this.tmuxCommand(["send-keys", "-t", paneId, item.submitKey]);
			} finally {
				this.sendActive.delete(paneId);
			}
			this.drainSendQueue(paneId);
		}, 200);
	}

	/** Exposed for testing. */
	buildWrapperScript(options: RuntimeSpawnOptions): string {
		const sockPath = join(options.salonDir, "salon.sock");
		const tmuxSession = this.tmuxSession;
		return [
			`#!/usr/bin/env bash`,
			`set -uo pipefail -m`,
			...(tmuxSession ? [filteredEnvEval(tmuxSession)] : []),
			`export PATH="$SALON_NODE_BIN:$PATH"`,
			`export SALON_DIR=${shellQuote(options.salonDir)} SALON_GUEST_NAME=${shellQuote(options.name)}`,
			`SOCK=${shellQuote(sockPath)}`,
			`send_system_event() {`,
			`  local event="$1"`,
			`  printf '{"from":"_system","content":"%s"}' "$event" | nc -U "$SOCK" 2>/dev/null || true`,
			`}`,
			`(`,
			`  for _ in $(seq 1 150); do`,
			`    CURRENT_COMMAND=$(tmux display-message -p -t "$TMUX_PANE" "#{pane_current_command}" 2>/dev/null || true)`,
			`    if [ -n "$CURRENT_COMMAND" ] && [ "$CURRENT_COMMAND" != "bash" ] && [ "$CURRENT_COMMAND" != "zsh" ] && [ "$CURRENT_COMMAND" != "sh" ]; then`,
			`      for _ in $(seq 1 60); do`,
			`        PANE_CONTENT=$(tmux capture-pane -t "$TMUX_PANE" -p 2>/dev/null || true)`,
			`        if printf '%s' "$PANE_CONTENT" | grep -qE '${TUI_PATTERNS.readyPromptGrepPattern}'; then`,
			`          sleep 0.3`,
			`          send_system_event "guest_ready:${options.name}"`,
			`          exit 0`,
			`        fi`,
			`        sleep 0.5`,
			`      done`,
			`      send_system_event "guest_ready:${options.name}"`,
			`      exit 0`,
			`    fi`,
			`    sleep 0.2`,
			`  done`,
			`  send_system_event "guest_ready_timeout:${options.name}"`,
			`) &`,
			`READY_WATCHER=$!`,
			`cd ${shellQuote(options.workDir)}`,
			// Do not use exec; after the command exits we still need to extract the session id and notify the host.
			options.command,
			`wait "$READY_WATCHER" 2>/dev/null || true`,
			`SESSION_ID=${shellQuote(options.initialSessionId || "")}`,
			`if [ -z "$SESSION_ID" ]; then`,
			`  CAPTURED=$(tmux capture-pane -t "$TMUX_PANE" -p -S -20 2>/dev/null || true)`,
			`  SESSION_ID=$(echo "$CAPTURED" | grep -o 'claude --resume [^ ]*' | tail -1 | awk '{print $3}')`,
			`fi`,
			`if [ -z "$SESSION_ID" ]; then`,
			`  CAPTURED=$(tmux capture-pane -t "$TMUX_PANE" -p -S -20 2>/dev/null || true)`,
			`  SESSION_ID=$(echo "$CAPTURED" | grep -o 'codex resume [^ ]*' | tail -1 | awk '{print $3}')`,
			`fi`,
			`send_system_event "guest_exited:${options.name}:$SESSION_ID"`,
		].join("\n");
	}
}

// ── Session-level bootstrap ──────────────────────────────────────────

export class TmuxLauncher implements SalonLauncher {
	private readonly tmuxSession: string;
	private hostWorkDir?: string;

	constructor(tmuxSession: string) {
		this.tmuxSession = tmuxSession;
	}

	preflight(): void {
		execFileSync("tmux", ["-V"], { stdio: "pipe" });
	}

	sessionExists(): boolean {
		try {
			execFileSync("tmux", ["has-session", "-t", this.tmuxSession], { stdio: "pipe" });
			return true;
		} catch {
			return false;
		}
	}

	createSession(workDir: string): void {
		this.hostWorkDir = workDir;
		if (!this.sessionExists()) {
			this.tmuxCommand([
				"new-session",
				"-d",
				"-s",
				this.tmuxSession,
				"-x",
				"200",
				"-y",
				"50",
				"-c",
				workDir,
				// Keep the pane alive without starting the user's interactive shell.
				nonInteractiveBashCommand("exec tail -f /dev/null"),
			]);
		}
		this.tmuxCommand(["set-option", "-t", this.tmuxSession, "-g", "mouse", "on"]);
		this.tmuxCommand(["set-option", "-t", this.tmuxSession, "-g", "extended-keys", "always"]);
		this.tmuxCommand(["set-option", "-t", this.tmuxSession, "-g", "extended-keys-format", "csi-u"]);
		this.tmuxCommand(["set-option", "-t", this.tmuxSession, "pane-border-status", "top"]);
		this.tmuxCommand(["set-option", "-t", this.tmuxSession, "pane-border-format", ` #{${SALON_NAME_OPTION}} `]);
		this.tmuxCommand(["set-option", "-p", "-t", `${this.tmuxSession}:0.0`, SALON_NAME_OPTION, "host"]);
		this.tmuxCommand(["rename-window", "-t", `${this.tmuxSession}:0`, "salon"]);
	}

	destroySession(): void {
		try {
			this.tmuxCommand(["kill-session", "-t", this.tmuxSession]);
		} catch (error) {
			if (isTmuxMissingSessionError(error)) return;
			throw error;
		}
	}

	attach(): void {
		execFileSync("tmux", ["attach", "-t", this.tmuxSession], { stdio: "inherit" });
	}

	setEnvironment(vars: Record<string, string>): void {
		for (const [key, value] of Object.entries(vars)) {
			this.tmuxCommand(["set-environment", "-t", this.tmuxSession, key, value]);
		}
	}

	launchHost(command: string): void {
		const hostPane = `${this.tmuxSession}:0.0`;
		const envSetup = `${filteredEnvEval(this.tmuxSession)} && export PATH="$SALON_NODE_BIN:$PATH"`;
		// Replace the placeholder process with the host directly, again avoiding
		// any interactive shell startup output in the pane.
		const launchCommand = nonInteractiveBashCommand(`${envSetup} && exec ${command}`);
		const args = ["respawn-pane", "-k", "-t", hostPane];
		if (this.hostWorkDir) {
			args.push("-c", this.hostWorkDir);
		}
		args.push(launchCommand);
		this.tmuxCommand(args);
	}

	private tmuxCommand(args: string[]): string {
		return runTmux(args, "required");
	}
}
