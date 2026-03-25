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

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function submitKeyForGuestType(type: "claude" | "codex"): string {
	return type === "codex" ? "C-m" : "Enter";
}

function terminateCommandForGuestType(type: "claude" | "codex"): string {
	return type === "claude" ? "/exit" : "exit";
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
		const runtimeId = this.spawnPane(options.workDir);
		if (!runtimeId) throw new Error("Failed to create tmux pane");

		const submitKey = submitKeyForGuestType(options.guestType);
		this.submitKeys.set(runtimeId, submitKey);

		const wrapperScript = join(options.salonDir, "guests", `${options.name}.wrapper.sh`);
		writeFileSync(wrapperScript, this.buildWrapperScript(options));
		chmodSync(wrapperScript, 0o755);

		this.sendRaw(runtimeId, `exec bash ${shellQuote(wrapperScript)}`, "Enter");
		return runtimeId;
	}

	send(runtimeId: string, text: string): void {
		const submitKey = this.submitKeys.get(runtimeId);
		if (!submitKey) throw new Error(`No submit key registered for runtime '${runtimeId}'. Was spawn() called?`);
		this.sendRaw(runtimeId, text, submitKey);
	}

	interrupt(runtimeId: string): void {
		this.tmux(["send-keys", "-t", runtimeId, "C-c"]);
		this.tmux(["send-keys", "-t", runtimeId, "C-c"]);
	}

	terminate(runtimeId: string, guestType: "claude" | "codex"): void {
		this.tmux(["send-keys", "-t", runtimeId, "-l", terminateCommandForGuestType(guestType)]);
		this.tmux(["send-keys", "-t", runtimeId, "Enter"]);
	}

	getStatus(runtimeId: string): GuestStatus {
		const content = this.tmux(["capture-pane", "-t", runtimeId, "-p"]);
		if (!content) return "new";

		let linesChecked = 0;
		const lines = content.split("\n");
		for (let i = lines.length - 1; i >= 0; i--) {
			const trimmed = lines[i].trim();
			if (!trimmed) continue;

			// Input: permission prompt (Claude Code)
			if (linesChecked === 0 && trimmed.includes("Esc to cancel")) {
				return "input";
			}

			// Working: spinner characters with ellipsis (Claude Code)
			const first = trimmed.charAt(0);
			if ("\u273D\u2722\u2733\u2736\u23FA\u2726\u2727\u2728\u2729\u272A\u272B\u272C\u272D\u272E\u272F\u2730\u2731\u2732\u2734\u2735\u2737\u2738\u2739\u273A\u273B\u273C".includes(first) && trimmed.includes("\u2026")) {
				return "working";
			}

			// Working: braille spinner (Codex CLI)
			if ("\u280B\u2819\u2839\u2838\u283C\u2834\u2826\u2827\u2807\u280F".includes(first)) {
				return "working";
			}

			// Input: selection menu "❯ N." (Claude Code approval)
			const idx = trimmed.indexOf("\u276F");
			if (idx >= 0) {
				const after = trimmed.slice(idx + 1).trimStart();
				if (/^\d/.test(after)) return "input";
			}

			// Input: approval prompt (Codex CLI)
			if (linesChecked === 0 && /\(y\/n\)/i.test(trimmed)) {
				return "input";
			}

			linesChecked++;
			if (linesChecked >= 10) break;
		}

		return "idle";
	}

	isAlive(runtimeId: string): boolean {
		return this.listAlive().includes(runtimeId);
	}

	focus(runtimeId: string): void {
		this.tmux(["select-pane", "-t", runtimeId]);
	}

	equalize(): void {
		const panes = this.listAlive();
		if (panes.length <= 1) return;
		const totalWidth = this.tmux(["display-message", "-t", `${this.tmuxSession}:0`, "-p", "#{window_width}"]);
		const halfWidth = Math.floor(Number(totalWidth) / 2);
		this.tmux(["set-option", "-t", `${this.tmuxSession}:0`, "main-pane-width", String(halfWidth)]);
		this.tmux(["select-layout", "-t", `${this.tmuxSession}:0`, "main-vertical"]);
		this.tmux(["select-pane", "-t", `${this.tmuxSession}:0.0`]);
	}

	destroySession(): void {
		this.tmux(["kill-session", "-t", this.tmuxSession]);
	}

	// ── Internal helpers ─────────────────────────────────────────────

	private listAlive(): string[] {
		return this.tmux(["list-panes", "-t", `${this.tmuxSession}:0`, "-F", "#{pane_id}"]).split("\n").filter(Boolean);
	}

	private tmux(args: string[]): string {
		try {
			return execFileSync("tmux", args, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
		} catch {
			return "";
		}
	}

	private spawnPane(workDir: string): string {
		const panes = this.listAlive();
		let newPaneId: string;
		if (panes.length <= 1) {
			newPaneId = this.tmux(["split-window", "-h", "-t", `${this.tmuxSession}:0.0`, "-p", "50", "-c", workDir, "-P", "-F", "#{pane_id}"]);
		} else {
			const lastPane = panes[panes.length - 1];
			newPaneId = this.tmux(["split-window", "-v", "-t", lastPane, "-c", workDir, "-P", "-F", "#{pane_id}"]);
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

	private drainSendQueue(paneId: string): void {
		if (this.sendActive.has(paneId)) return;
		const queue = this.sendQueues.get(paneId);
		if (!queue?.length) {
			this.sendQueues.delete(paneId);
			return;
		}

		this.sendActive.add(paneId);
		const item = queue.shift()!;
		this.tmux(["send-keys", "-l", "-t", paneId, item.text]);
		setTimeout(() => {
			this.tmux(["send-keys", "-t", paneId, item.submitKey]);
			this.sendActive.delete(paneId);
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
			...(tmuxSession ? [`eval "$(tmux show-environment -t ${shellQuote(tmuxSession)} -s)"`] : []),
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
			`        if printf '%s' "$PANE_CONTENT" | grep -qE '❯|› '; then`,
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
		if (!this.sessionExists()) {
			this.tmux(["new-session", "-d", "-s", this.tmuxSession, "-x", "200", "-y", "50", "-c", workDir]);
		}
		this.tmux(["set-option", "-t", this.tmuxSession, "-g", "mouse", "on"]);
		this.tmux(["set-option", "-t", this.tmuxSession, "-g", "extended-keys", "on"]);
		this.tmux(["set-option", "-t", this.tmuxSession, "-g", "extended-keys-format", "csi-u"]);
		this.tmux(["rename-window", "-t", `${this.tmuxSession}:0`, "salon"]);
	}

	destroySession(): void {
		this.tmux(["kill-session", "-t", this.tmuxSession]);
	}

	attach(): void {
		execFileSync("tmux", ["attach", "-t", this.tmuxSession], { stdio: "inherit" });
	}

	setEnvironment(vars: Record<string, string>): void {
		for (const [key, value] of Object.entries(vars)) {
			this.tmux(["set-environment", "-t", this.tmuxSession, key, value]);
		}
	}

	launchHost(command: string): void {
		const hostPane = `${this.tmuxSession}:0.0`;
		const envSetup = `eval "$(tmux show-environment -t ${shellQuote(this.tmuxSession)} -s)" && export PATH="$SALON_NODE_BIN:$PATH"`;
		this.tmux(["send-keys", "-t", hostPane, "-l", `${envSetup} && exec ${command}`]);
		this.tmux(["send-keys", "-t", hostPane, "Enter"]);
	}

	private tmux(args: string[]): string {
		try {
			return execFileSync("tmux", args, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
		} catch {
			return "";
		}
	}
}
