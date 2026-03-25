/**
 * Salon — a pi extension for multi-agent collaboration.
 *
 * The host (this pi instance) coordinates guest agents
 * (Claude Code / Codex CLI) in tmux panes.
 *
 * Run: pi --extension ./src/extension.ts
 */

import { DynamicBorder, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, realpathSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { createServer, type Server } from "node:net";

const SALON_INSTANCE = process.env.SALON_INSTANCE || "default";
const TMUX_SESSION = process.env.SALON_TMUX_SESSION || `salon-${SALON_INSTANCE}`;
const SALON_STATE_ENTRY_TYPE = "salon_state";
const SALON_STATE_VERSION = 1;
type GuestType = "claude" | "codex";
type GuestTeardownReason = "host" | "user";
type GuestLifecycleStatus = "active" | "dismissing" | "suspended" | "dismissed";
type GuestStatus = "starting" | "working" | "input" | "idle" | "new";

interface GuestRuntimeFile {
	name: string;
	type: GuestType;
	paneId: string;
	sessionId?: string;
	nonce?: string;
	startedAt?: string;
	workspaceDir?: string;
}

interface GuestInfo {
	name: string;
	type: GuestType;
	paneId: string;
	submitKey: string;
	sessionId?: string;
	nonce?: string;
	startedAt: number;
	status: GuestLifecycleStatus;
	workspaceDir: string;
	ready: boolean;
	teardownReason?: GuestTeardownReason;
}

interface Deferred<T> {
	promise: Promise<T>;
	resolve: (value: T | PromiseLike<T>) => void;
}

// Guests that are not currently active but may still be resumable.
const dismissedGuests = new Map<string, GuestInfo>();

// ── Discussion state machine ──────────────────────────────────────────
type DiscussionStage = "exploring" | "debating" | "synthesizing" | "done";

interface DiscussionRound {
	responses: Map<string, string>;  // guest name → their response this round
}

interface Discussion {
	id: string;
	topic: string;
	guestA: string;
	guestB: string;
	stage: DiscussionStage;
	rounds: DiscussionRound[];      // all rounds of exchange
	currentRound: DiscussionRound;  // the round being collected
}

interface PersistedGuestInfo {
	name: string;
	type: GuestType;
	status: GuestLifecycleStatus;
	sessionId?: string;
	nonce?: string;
	startedAt?: string;
	workspaceDir?: string;
}

interface PersistedDiscussionRound {
	responses: Record<string, string>;
}

interface PersistedDiscussion {
	id: string;
	topic: string;
	guestA: string;
	guestB: string;
	stage: DiscussionStage;
	rounds: PersistedDiscussionRound[];
	currentRound: PersistedDiscussionRound;
}

interface SalonStateSnapshot {
	version: typeof SALON_STATE_VERSION;
	guests: Record<string, PersistedGuestInfo>;
	discussions: Record<string, PersistedDiscussion>;
	updatedAt: string;
}

interface SalonSessionInfo {
	path: string;
	id: string;
	timestamp: string;
	name?: string;
	guestCount: number;
	discussionCount: number;
	modified: Date;
}

const guests = new Map<string, GuestInfo>();
const discussions = new Map<string, Discussion>();
const archivedDiscussions = new Map<string, Discussion>();
// Track which guest belongs to which discussion
const guestToDiscussion = new Map<string, string>();
const claimedSessionIds = new Set<string>();
const activeCodexSessionScans = new Map<string, ReturnType<typeof setTimeout>>();
const queuedGuestMessages = new Map<string, Array<{ message: string; from: string }>>();
const guestExitWaiters = new Map<string, Deferred<void>>();

const CODEX_SESSION_SCAN_INITIAL_DELAY_MS = 2000;
const CODEX_SESSION_SCAN_INTERVAL_MS = 2000;
const CODEX_SESSION_SCAN_TIMEOUT_MS = 30000;
const CODEX_SESSION_SCAN_MAX_FIRST_LINE_BYTES = 16 * 1024;

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function createDeferred<T>(): Deferred<T> {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

function joinShellArgs(args: string[]): string {
	return args.map(shellQuote).join(" ");
}

function sanitizeGuestName(name: string): string {
	if (!/^[A-Za-z0-9._-]+$/.test(name)) {
		throw new Error(`Invalid guest name '${name}'. Use only letters, numbers, dot, underscore, or dash.`);
	}
	return name;
}

function safeLabelForFilename(value: string): string {
	const sanitized = value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
	return sanitized || "guest";
}

function cancelCodexSessionScan(name: string) {
	const timer = activeCodexSessionScans.get(name);
	if (timer) {
		clearTimeout(timer);
		activeCodexSessionScans.delete(name);
	}
}

function tmux(args: string[]): string {
	try {
		return execFileSync("tmux", args, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
	} catch {
		return "";
	}
}

function spawnPane(workDir: string): string {
	const paneCount = tmux(["list-panes", "-t", `${TMUX_SESSION}:0`, "-F", "#{pane_id}"]).split("\n").filter(Boolean).length;
	let newPaneId: string;
	if (paneCount <= 1) {
		newPaneId = tmux(["split-window", "-h", "-t", `${TMUX_SESSION}:0.0`, "-p", "50", "-c", workDir, "-P", "-F", "#{pane_id}"]);
	} else {
		const lastPane = tmux(["list-panes", "-t", `${TMUX_SESSION}:0`, "-F", "#{pane_id}"]).split("\n").filter(Boolean).pop()!;
		newPaneId = tmux(["split-window", "-v", "-t", lastPane, "-c", workDir, "-P", "-F", "#{pane_id}"]);
		// Re-balance: main-vertical distributes guests evenly in right column
		// Then set main pane (host) to 50% width to keep 1:1 ratio
		const totalWidth = tmux(["display-message", "-t", `${TMUX_SESSION}:0`, "-p", "#{window_width}"]);
		const halfWidth = Math.floor(Number(totalWidth) / 2);
		tmux(["set-option", "-t", `${TMUX_SESSION}:0`, "main-pane-width", String(halfWidth)]);
		tmux(["select-layout", "-t", `${TMUX_SESSION}:0`, "main-vertical"]);
	}
	// Keep focus on host pane
	tmux(["select-pane", "-t", `${TMUX_SESSION}:0.0`]);
	return newPaneId;
}

// ── Guest status detection (inspired by gavraz/recon) ─────────────────
function detectGuestStatus(paneId: string): GuestStatus {
	const content = tmux(["capture-pane", "-t", paneId, "-p"]);
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

		// Input: selection menu "❯ N." (Claude Code approval)
		const idx = trimmed.indexOf("\u276F");
		if (idx >= 0) {
			const after = trimmed.slice(idx + 1).trimStart();
			if (/^\d/.test(after)) return "input";
		}

		// Codex: check for "›" prompt with no content after = idle
		// Codex working: has a spinner/progress indicator

		linesChecked++;
		if (linesChecked >= 10) break;
	}

	return "idle";
}

// Per-pane async send queue: TUI applications need time to process pasted text
// before receiving the submit key. This queue serializes sends per pane with a
// non-blocking delay between text and submit, avoiding event loop blocking.
const paneSendQueues = new Map<string, Array<{ text: string; submitKey: string }>>();
const paneSendActive = new Set<string>();

function sendKeys(paneId: string, text: string, submitKey = "Enter") {
	const queue = paneSendQueues.get(paneId) || [];
	queue.push({ text, submitKey });
	paneSendQueues.set(paneId, queue);
	drainPaneSendQueue(paneId);
}

function drainPaneSendQueue(paneId: string) {
	if (paneSendActive.has(paneId)) return;
	const queue = paneSendQueues.get(paneId);
	if (!queue?.length) {
		paneSendQueues.delete(paneId);
		return;
	}

	paneSendActive.add(paneId);
	const item = queue.shift()!;
	tmux(["send-keys", "-l", "-t", paneId, item.text]);
	setTimeout(() => {
		tmux(["send-keys", "-t", paneId, item.submitKey]);
		paneSendActive.delete(paneId);
		drainPaneSendQueue(paneId);
	}, 200);
}

// ── Unix socket server for receiving guest messages ───────────────────
function startMessageServer(
	socketPath: string,
	onMessage: (msg: { from: string; content: string }) => void,
): Server {
	// Clean up stale socket
	if (existsSync(socketPath)) unlinkSync(socketPath);

	const server = createServer((conn) => {
		let data = "";
		let handled = false;
		function tryHandle() {
			if (handled) return;
			try {
				const msg = JSON.parse(data);
				if (msg.from && msg.content) {
					handled = true;
					onMessage(msg);
				}
			} catch { /* incomplete JSON, wait for more data */ }
			if (handled) conn.destroy();
		}
		conn.on("data", (chunk) => { data += chunk.toString(); tryHandle(); });
		conn.on("end", tryHandle);
	});

	server.listen(socketPath);
	return server;
}

const GUEST_INSTRUCTIONS =
	`You are in a salon — a collaborative workspace where a host agent coordinates multiple agents. ` +
	`Messages prefixed with [name]: are from the host or another agent. Your response to these is automatically forwarded back. ` +
	`Messages without a [name]: prefix are from a human interacting with you directly. These stay private. ` +
	`When you respond, just respond normally — do NOT add any [name]: prefix to your own replies.`;

function createCodexGuestNonce(): string {
	return `SALON_NONCE:${randomUUID().replace(/-/g, "").slice(0, 8)}`;
}

function buildGuestInstructions(nonce?: string): string {
	return nonce ? `${GUEST_INSTRUCTIONS}\n\n${nonce}` : GUEST_INSTRUCTIONS;
}

function normalizePath(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}

function git(args: string[], cwd: string): string | undefined {
	try {
		return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
	} catch {
		return undefined;
	}
}


function serializeStartedAt(startedAt: number): string {
	return new Date(startedAt).toISOString();
}

function parseStartedAt(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const startedAt = Date.parse(value);
	return Number.isFinite(startedAt) ? startedAt : undefined;
}

function readFirstLine(filePath: string): string | undefined {
	let fd: number | undefined;
	const chunks: Buffer[] = [];
	let bytesBuffered = 0;
	let position = 0;
	const buffer = Buffer.alloc(4096);

	try {
		fd = openSync(filePath, "r");
		while (bytesBuffered < CODEX_SESSION_SCAN_MAX_FIRST_LINE_BYTES) {
			const bytesToRead = Math.min(buffer.length, CODEX_SESSION_SCAN_MAX_FIRST_LINE_BYTES - bytesBuffered);
			const bytesRead = readSync(fd, buffer, 0, bytesToRead, position);
			if (bytesRead <= 0) break;

			const chunk = Buffer.from(buffer.subarray(0, bytesRead));
			const newlineIndex = chunk.indexOf(0x0A);
			if (newlineIndex >= 0) {
				chunks.push(chunk.subarray(0, newlineIndex));
				break;
			}

			chunks.push(chunk);
			bytesBuffered += bytesRead;
			position += bytesRead;

			if (bytesRead < bytesToRead) break;
		}

		const firstLine = Buffer.concat(chunks).toString("utf-8").trim();
		return firstLine || undefined;
	} catch {
		return undefined;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

function getCodexSessionDateDirs(startedAt: number): string[] {
	const dirs = new Set<string>();
	for (const dayOffset of [-1, 0, 1]) {
		const date = new Date(startedAt);
		date.setDate(date.getDate() + dayOffset);
		const year = String(date.getFullYear());
		const month = String(date.getMonth() + 1).padStart(2, "0");
		const day = String(date.getDate()).padStart(2, "0");
		dirs.add(join(homedir(), ".codex", "sessions", year, month, day));
	}
	return Array.from(dirs);
}

function submitKeyForGuestType(type: GuestType): string {
	return type === "codex" ? "C-m" : "Enter";
}

function serializeDiscussionRound(round: DiscussionRound): PersistedDiscussionRound {
	return { responses: Object.fromEntries(round.responses) };
}

function deserializeDiscussionRound(round: PersistedDiscussionRound | undefined): DiscussionRound {
	return { responses: new Map(Object.entries(round?.responses || {})) };
}

function serializeDiscussion(disc: Discussion): PersistedDiscussion {
	return {
		id: disc.id,
		topic: disc.topic,
		guestA: disc.guestA,
		guestB: disc.guestB,
		stage: disc.stage,
		rounds: disc.rounds.map(serializeDiscussionRound),
		currentRound: serializeDiscussionRound(disc.currentRound),
	};
}

function deserializeDiscussion(disc: PersistedDiscussion): Discussion {
	return {
		id: disc.id,
		topic: disc.topic,
		guestA: disc.guestA,
		guestB: disc.guestB,
		stage: disc.stage,
		rounds: (disc.rounds || []).map(deserializeDiscussionRound),
		currentRound: deserializeDiscussionRound(disc.currentRound),
	};
}

interface CodexSessionMetaPayload {
	id?: string;
	base_instructions?: { text?: string };
	timestamp?: string | number;
	cwd?: string;
}

interface CodexSessionMetaEntry {
	type: string;
	payload?: CodexSessionMetaPayload;
}

interface CodexSessionScanCandidate {
	sessionId: string;
	nonceMatched: boolean;
	cwdMatched: boolean;
	timestampDistanceMs: number;
}

interface RecoveredSalonSummaryInput {
	salonInstance: string;
	workDir: string;
	activeGuests: Array<Pick<GuestInfo, "name" | "type" | "paneId" | "workspaceDir" | "sessionId" | "ready">>;
	suspendedGuests: Array<Pick<GuestInfo, "name" | "type" | "workspaceDir" | "sessionId">>;
	dismissedGuests: Array<Pick<GuestInfo, "name" | "type" | "workspaceDir" | "sessionId">>;
	activeDiscussions: Array<{
		topic: string;
		stage: DiscussionStage;
		completedRounds: number;
		guestA: string;
		guestB: string;
		awaiting: string[];
	}>;
	archivedPendingDiscussions: Array<{
		topic: string;
		stage: DiscussionStage;
		completedRounds: number;
		guestA: string;
		guestB: string;
	}>;
}

function isBetterCodexSessionCandidate(
	next: CodexSessionScanCandidate,
	current: CodexSessionScanCandidate | undefined,
): boolean {
	if (!current) return true;
	if (next.nonceMatched !== current.nonceMatched) return next.nonceMatched;
	if (next.cwdMatched !== current.cwdMatched) return next.cwdMatched;
	if (next.timestampDistanceMs !== current.timestampDistanceMs) {
		return next.timestampDistanceMs < current.timestampDistanceMs;
	}
	return next.sessionId < current.sessionId;
}

function buildGuestExitWrapperScript(options: {
	name: string;
	salonDir: string;
	workDir: string;
	command: string;
	initialSessionId?: string;
}): string {
	const sockPath = join(options.salonDir, "salon.sock");
	const tmuxSession = process.env.SALON_TMUX_SESSION || "";
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

function formatRecoveredSalonSummary(input: RecoveredSalonSummaryInput): string | undefined {
	if (
		input.activeGuests.length === 0 &&
		input.suspendedGuests.length === 0 &&
		input.dismissedGuests.length === 0 &&
		input.activeDiscussions.length === 0 &&
		input.archivedPendingDiscussions.length === 0
	) {
		return undefined;
	}

	const lines: string[] = [
		`Recovered salon state for instance '${input.salonInstance}' after session resume.`,
		`Working directory: ${input.workDir}`,
	];

	if (input.activeGuests.length > 0) {
		lines.push(`Active guests:`);
		for (const guest of input.activeGuests) {
			lines.push(
				`- ${guest.name} (${guest.type}) pane=${guest.paneId} workspace=${guest.workspaceDir} session=${guest.sessionId || "none"} ready=${guest.ready ? "yes" : "no"}`,
			);
		}
	}

	if (input.suspendedGuests.length > 0) {
		lines.push(`Suspended guests (auto-paused when host exited, ready to resume):`);
		for (const guest of input.suspendedGuests) {
			lines.push(`- ${guest.name} (${guest.type}) workspace=${guest.workspaceDir} session=${guest.sessionId || "none"}`);
		}
	}

	if (input.dismissedGuests.length > 0) {
		lines.push(`Dismissed guests:`);
		for (const guest of input.dismissedGuests) {
			lines.push(`- ${guest.name} (${guest.type}) workspace=${guest.workspaceDir} session=${guest.sessionId || "none"}`);
		}
	}

	if (input.activeDiscussions.length > 0) {
		lines.push(`Active discussions:`);
		for (const discussion of input.activeDiscussions) {
			lines.push(
				`- topic=${discussion.topic}; stage=${discussion.stage}; completed_rounds=${discussion.completedRounds}; guests=${discussion.guestA}, ${discussion.guestB}; awaiting=${discussion.awaiting.join(", ") || "none"}`,
			);
		}
	}

	if (input.archivedPendingDiscussions.length > 0) {
		lines.push(`Archived discussions waiting on guest resume:`);
		for (const discussion of input.archivedPendingDiscussions) {
			lines.push(
				`- topic=${discussion.topic}; stage=${discussion.stage}; completed_rounds=${discussion.completedRounds}; guests=${discussion.guestA}, ${discussion.guestB}`,
			);
		}
	}

	return lines.join("\n");
}

// ── Invite a guest (shared logic) ─────────────────────────────────────
function inviteGuest(
	name: string,
	type: GuestType,
	workDir: string,
	salonDir: string,
	guestDir: string,
): GuestInfo {
	name = sanitizeGuestName(name);
	if (guests.has(name)) throw new Error(`Guest '${name}' is already in the salon`);

	cancelCodexSessionScan(name);

	const paneId = spawnPane(workDir);
	if (!paneId) throw new Error("Failed to create tmux pane");

	const submitKey = submitKeyForGuestType(type);
	const sessionId = type === "claude" ? randomUUID() : undefined;
	const nonce = type === "codex" ? createCodexGuestNonce() : undefined;
	const guest: GuestInfo = {
		name,
		type,
		paneId,
		submitKey,
		sessionId,
		nonce,
		startedAt: Date.now(),
		status: "active",
		workspaceDir: workDir,
		ready: false,
	};
	guests.set(name, guest);
	if (guest.sessionId) claimedSessionIds.add(guest.sessionId);
	queuedGuestMessages.delete(name);
	writeFileSync(join(guestDir, `${name}.json`), JSON.stringify({
		name: guest.name,
		type: guest.type,
		paneId: guest.paneId,
		sessionId: guest.sessionId,
		nonce: guest.nonce,
		startedAt: serializeStartedAt(guest.startedAt),
		workspaceDir: guest.workspaceDir,
	} satisfies GuestRuntimeFile, null, 2));

	const instructions = buildGuestInstructions(guest.nonce);

	// Inject guest role into system prompt, not as a chat message
	// Write instructions to a temp file to avoid shell escaping issues
	const instructionsFile = join(guestDir, `${name}.instructions`);
	writeFileSync(instructionsFile, instructions);

	let cmd: string;
	if (type === "codex") {
		cmd = joinShellArgs(["codex", "-c", `model_instructions_file=${instructionsFile}`]);
	} else {
		const exchangeDir = join(salonDir, "exchange");
		mkdirSync(exchangeDir, { recursive: true });
		cmd = joinShellArgs([
			"claude",
			"--session-id",
			sessionId!,
			"--append-system-prompt-file",
			instructionsFile,
			"--add-dir",
			exchangeDir,
		]);
	}

	// Wrapper script: run agent, capture session ID after exit, notify host, then shell exits (pane closes)
	const wrapperScript = join(guestDir, `${name}.wrapper.sh`);
	writeFileSync(wrapperScript, buildGuestExitWrapperScript({
		name,
		salonDir,
		workDir,
		command: cmd,
		initialSessionId: guest.sessionId,
	}));
	chmodSync(wrapperScript, 0o755);

	sendKeys(paneId, `exec bash ${shellQuote(wrapperScript)}`);

	return guest;
}

export default function salonExtension(pi: ExtensionAPI) {
	const salonDir = process.env.SALON_DIR || join("/tmp", "salon", SALON_INSTANCE);
	const guestDir = join(salonDir, "guests");
	const hostSessionDir = join(salonDir, "host-sessions");
	const workDir = process.env.SALON_WORK_DIR || process.cwd();

	mkdirSync(guestDir, { recursive: true });
	writeFileSync(join(salonDir, "host.pid"), String(process.pid));

	const MSG_LENGTH_THRESHOLD = 2000;
	let msgFileCounter = 0;
	let pendingResumeSummary: string | undefined;

	pi.on("session_directory", () => {
		mkdirSync(hostSessionDir, { recursive: true });
		return { sessionDir: hostSessionDir };
	});

	function writeGuestRuntimeFile(guest: GuestInfo) {
		const runtimeFile: GuestRuntimeFile = {
			name: guest.name,
			type: guest.type,
			paneId: guest.paneId,
			sessionId: guest.sessionId,
			nonce: guest.nonce,
			startedAt: serializeStartedAt(guest.startedAt),
			workspaceDir: guest.workspaceDir,
		};
		writeFileSync(join(guestDir, `${guest.name}.json`), JSON.stringify(runtimeFile, null, 2));
	}

	function readGuestRuntimeFile(name: string): GuestRuntimeFile | undefined {
		const file = join(guestDir, `${name}.json`);
		if (!existsSync(file)) return undefined;
		try {
			const parsed = JSON.parse(readFileSync(file, "utf-8")) as Partial<GuestRuntimeFile>;
			if (!parsed || typeof parsed !== "object") return undefined;
			if (typeof parsed.name !== "string" || typeof parsed.type !== "string" || typeof parsed.paneId !== "string") {
				return undefined;
			}
			if (parsed.type !== "claude" && parsed.type !== "codex") return undefined;
			return {
				name: parsed.name,
				type: parsed.type,
				paneId: parsed.paneId,
				sessionId: typeof parsed.sessionId === "string" ? parsed.sessionId : undefined,
				nonce: typeof parsed.nonce === "string" ? parsed.nonce : undefined,
				startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : undefined,
				workspaceDir: typeof parsed.workspaceDir === "string" ? parsed.workspaceDir : undefined,
			};
		} catch {
			return undefined;
		}
	}

	function serializeGuestInfo(guest: GuestInfo): PersistedGuestInfo {
		return {
			name: guest.name,
			type: guest.type,
			status: guest.status,
			sessionId: guest.sessionId,
			nonce: guest.nonce,
			startedAt: serializeStartedAt(guest.startedAt),
			workspaceDir: guest.workspaceDir,
		};
	}

	function refreshClaimedSessionIds() {
		claimedSessionIds.clear();
		for (const guest of guests.values()) {
			if (guest.sessionId) claimedSessionIds.add(guest.sessionId);
		}
		for (const guest of dismissedGuests.values()) {
			if (guest.sessionId) claimedSessionIds.add(guest.sessionId);
		}
	}

	function claimGuestSessionId(guest: GuestInfo, sessionId: string) {
		guest.sessionId = sessionId;
		claimedSessionIds.add(sessionId);
		writeGuestRuntimeFile(guest);
		persistSalonState();
	}

	function ensureGuestExitWaiter(guest: GuestInfo): Promise<void> {
		const existing = guestExitWaiters.get(guest.name);
		if (existing) return existing.promise;
		const deferred = createDeferred<void>();
		guestExitWaiters.set(guest.name, deferred);
		return deferred.promise;
	}

	function settleGuestExitWaiter(name: string) {
		const waiter = guestExitWaiters.get(name);
		if (!waiter) return;
		guestExitWaiters.delete(name);
		waiter.resolve(undefined);
	}

	function findCodexSessionCandidate(guest: GuestInfo, normalizedWorkDir: string): CodexSessionScanCandidate | undefined {
		let bestCandidate: CodexSessionScanCandidate | undefined;

		for (const sessionsDir of getCodexSessionDateDirs(guest.startedAt)) {
			if (!existsSync(sessionsDir)) continue;

			for (const fileName of readdirSync(sessionsDir)) {
				if (!/^rollout-.*\.jsonl$/.test(fileName)) continue;

				const firstLine = readFirstLine(join(sessionsDir, fileName));
				if (!firstLine) continue;

				try {
					const entry = JSON.parse(firstLine) as CodexSessionMetaEntry;
					if (entry.type !== "session_meta" || !entry.payload || typeof entry.payload !== "object") continue;

					const payload = entry.payload;
					const sessionId = typeof payload.id === "string" ? payload.id : undefined;
					if (!sessionId || claimedSessionIds.has(sessionId)) continue;

					const baseInstructionsText = typeof payload.base_instructions?.text === "string"
						? payload.base_instructions.text
						: undefined;

					const timestampMs = typeof payload.timestamp === "string" || typeof payload.timestamp === "number"
						? Date.parse(String(payload.timestamp))
						: Number.NaN;
					const payloadCwd = typeof payload.cwd === "string" ? payload.cwd : undefined;

					const candidate: CodexSessionScanCandidate = {
						sessionId,
						nonceMatched: Boolean(guest.nonce && baseInstructionsText?.includes(guest.nonce)),
						cwdMatched: Boolean(payloadCwd && normalizePath(payloadCwd) === normalizedWorkDir),
						timestampDistanceMs: Number.isFinite(timestampMs)
							? Math.abs(timestampMs - guest.startedAt)
							: Number.POSITIVE_INFINITY,
					};

					if (isBetterCodexSessionCandidate(candidate, bestCandidate)) {
						bestCandidate = candidate;
					}
				} catch {
					// A newly created jsonl may still be empty or partially written; skip and retry later.
				}
			}
		}

		return bestCandidate;
	}

	function scanCodexSessionId(guest: GuestInfo) {
		if (guest.type !== "codex" || guest.sessionId || activeCodexSessionScans.has(guest.name)) return;

		const deadline = Date.now() + CODEX_SESSION_SCAN_TIMEOUT_MS;
		const scheduleAttempt = (delayMs: number) => {
			const timer = setTimeout(attemptScan, delayMs);
			activeCodexSessionScans.set(guest.name, timer);
		};

		const attemptScan = () => {
			activeCodexSessionScans.delete(guest.name);
			const trackedGuest = guests.get(guest.name) || dismissedGuests.get(guest.name);
			if (!trackedGuest || trackedGuest.type !== "codex") {
				return;
			}

			if (trackedGuest.sessionId) {
				claimedSessionIds.add(trackedGuest.sessionId);
				return;
			}

			const candidate = findCodexSessionCandidate(trackedGuest, normalizePath(trackedGuest.workspaceDir));
			if (candidate) {
				claimGuestSessionId(trackedGuest, candidate.sessionId);
				return;
			}

			if (Date.now() >= deadline) {
				return;
			}

			scheduleAttempt(CODEX_SESSION_SCAN_INTERVAL_MS);
		};

		scheduleAttempt(CODEX_SESSION_SCAN_INITIAL_DELAY_MS);
	}

	function scheduleMissingCodexSessionScans() {
		for (const guest of guests.values()) {
			if (guest.type === "codex" && !guest.sessionId) scanCodexSessionId(guest);
		}
		for (const guest of dismissedGuests.values()) {
			if (guest.type === "codex" && !guest.sessionId) scanCodexSessionId(guest);
		}
	}

	function buildSalonStateSnapshot(): SalonStateSnapshot {
		const snapshotGuests: Record<string, PersistedGuestInfo> = {};
		for (const [name, guest] of guests) {
			snapshotGuests[name] = serializeGuestInfo(guest);
		}
		for (const [name, guest] of dismissedGuests) {
			snapshotGuests[name] = serializeGuestInfo(guest);
		}

		const snapshotDiscussions: Record<string, PersistedDiscussion> = {};
		for (const [id, discussion] of discussions) {
			snapshotDiscussions[id] = serializeDiscussion(discussion);
		}
		for (const [id, discussion] of archivedDiscussions) {
			snapshotDiscussions[id] = serializeDiscussion(discussion);
		}

		return {
			version: SALON_STATE_VERSION,
			guests: snapshotGuests,
			discussions: snapshotDiscussions,
			updatedAt: new Date().toISOString(),
		};
	}

	function persistSalonState() {
		pi.appendEntry<SalonStateSnapshot>(SALON_STATE_ENTRY_TYPE, buildSalonStateSnapshot());
	}

	function clearRuntimeState() {
		pendingResumeSummary = undefined;
		for (const timer of activeCodexSessionScans.values()) {
			clearTimeout(timer);
		}
		for (const waiter of guestExitWaiters.values()) {
			waiter.resolve(undefined);
		}
		guests.clear();
		dismissedGuests.clear();
		discussions.clear();
		archivedDiscussions.clear();
		guestToDiscussion.clear();
		claimedSessionIds.clear();
		activeCodexSessionScans.clear();
		queuedGuestMessages.clear();
		guestExitWaiters.clear();
	}

	function restoreMsgFileCounter() {
		const exchangeDir = join(salonDir, "exchange");
		if (!existsSync(exchangeDir)) {
			msgFileCounter = 0;
			return;
		}

		let maxCounter = 0;
		for (const fileName of readdirSync(exchangeDir)) {
			const match = /^(\d+)_/.exec(fileName);
			if (!match) continue;
			maxCounter = Math.max(maxCounter, Number(match[1]));
		}
		msgFileCounter = maxCounter;
	}

	function isSalonStateSnapshot(value: unknown): value is SalonStateSnapshot {
		if (!value || typeof value !== "object") return false;
		const snapshot = value as Partial<SalonStateSnapshot>;
		return snapshot.version === SALON_STATE_VERSION &&
			typeof snapshot.guests === "object" &&
			snapshot.guests !== null &&
			typeof snapshot.discussions === "object" &&
			snapshot.discussions !== null;
	}

	function listSalonSessions(hostSessionDir: string): SalonSessionInfo[] {
		if (!existsSync(hostSessionDir)) return [];

		const sessions: SalonSessionInfo[] = [];
		for (const fileName of readdirSync(hostSessionDir)) {
			if (!fileName.endsWith(".jsonl")) continue;

			const sessionPath = join(hostSessionDir, fileName);

			try {
				const content = readFileSync(sessionPath, "utf8");
				const lines = content.split("\n").filter((line) => line.trim().length > 0);
				if (lines.length === 0) continue;

				const header = JSON.parse(lines[0]!) as { type?: string; id?: string; timestamp?: string };
				if (header.type !== "session" || typeof header.id !== "string" || typeof header.timestamp !== "string") {
					continue;
				}

				let name: string | undefined;
				let guestCount = 0;
				let discussionCount = 0;
				let foundName = false;
				let foundSalonState = false;

				for (let i = lines.length - 1; i >= 1; i--) {
					const line = lines[i];
					if (!line) continue;

					let entry: { type?: string; name?: string; customType?: string; data?: unknown } | undefined;
					try {
						entry = JSON.parse(line) as { type?: string; name?: string; customType?: string; data?: unknown };
					} catch {
						continue;
					}

					if (!foundName && entry.type === "session_info" && typeof entry.name === "string") {
						const trimmedName = entry.name.trim();
						if (trimmedName) {
							name = trimmedName;
							foundName = true;
						}
					}

					if (
						!foundSalonState &&
						entry.type === "custom" &&
						entry.customType === SALON_STATE_ENTRY_TYPE &&
						isSalonStateSnapshot(entry.data)
					) {
						guestCount = Object.keys(entry.data.guests).length;
						discussionCount = Object.keys(entry.data.discussions).length;
						foundSalonState = true;
					}

					if (foundName && foundSalonState) break;
				}

				sessions.push({
					path: sessionPath,
					id: header.id,
					timestamp: header.timestamp,
					name,
					guestCount,
					discussionCount,
					modified: statSync(sessionPath).mtime,
				});
			} catch {
				continue;
			}
		}

		sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
		return sessions;
	}

	function formatSessionLabel(timestamp: string, name?: string): string {
		const parsed = new Date(timestamp);
		if (Number.isNaN(parsed.getTime())) {
			return `${timestamp}  ${name || "(unnamed)"}`;
		}

		const year = parsed.getFullYear();
		const month = String(parsed.getMonth() + 1).padStart(2, "0");
		const day = String(parsed.getDate()).padStart(2, "0");
		const hours = String(parsed.getHours()).padStart(2, "0");
		const minutes = String(parsed.getMinutes()).padStart(2, "0");
		return `${year}-${month}-${day} ${hours}:${minutes}  ${name || "(unnamed)"}`;
	}

	function restoreSalonState(snapshot: SalonStateSnapshot) {
		clearRuntimeState();

		const livePanes = new Set(
			tmux(["list-panes", "-t", `${TMUX_SESSION}:0`, "-F", "#{pane_id}"]).split("\n").filter(Boolean),
		);

		for (const persistedGuest of Object.values(snapshot.guests || {})) {
			const runtimeGuest = readGuestRuntimeFile(persistedGuest.name);
			const baseGuest: GuestInfo = {
				name: persistedGuest.name,
				type: persistedGuest.type,
				paneId: "",
				submitKey: submitKeyForGuestType(persistedGuest.type),
				sessionId: runtimeGuest?.sessionId || persistedGuest.sessionId,
				nonce: runtimeGuest?.nonce || persistedGuest.nonce,
				startedAt:
					parseStartedAt(runtimeGuest?.startedAt) ||
					parseStartedAt(persistedGuest.startedAt) ||
					Date.now(),
				status: persistedGuest.status,
				workspaceDir: runtimeGuest?.workspaceDir || persistedGuest.workspaceDir || workDir,
				ready: false,
			};

			if (persistedGuest.status === "dismissed" || persistedGuest.status === "suspended") {
				dismissedGuests.set(baseGuest.name, baseGuest);
				continue;
			}

			if (runtimeGuest && livePanes.has(runtimeGuest.paneId)) {
				baseGuest.paneId = runtimeGuest.paneId;
				baseGuest.ready = true;
				guests.set(baseGuest.name, baseGuest);
				continue;
			}

			baseGuest.status = "suspended";
			dismissedGuests.set(baseGuest.name, baseGuest);
		}

		for (const [id, persistedDiscussion] of Object.entries(snapshot.discussions || {})) {
			const discussion = deserializeDiscussion(persistedDiscussion);
			if (
				discussion.stage !== "done" &&
				guests.has(persistedDiscussion.guestA) &&
				guests.has(persistedDiscussion.guestB)
			) {
				discussions.set(id, discussion);
				guestToDiscussion.set(discussion.guestA, id);
				guestToDiscussion.set(discussion.guestB, id);
			} else {
				archivedDiscussions.set(id, discussion);
			}
		}

		refreshClaimedSessionIds();
	}

	function getGuestDisplayStatus(guest: GuestInfo): string {
		if (guest.status === "dismissing") return "dismissing";
		if (!guest.ready) return "starting";
		return detectGuestStatus(guest.paneId);
	}

	function resolveInactiveGuestStatus(guest: GuestInfo): "suspended" | "dismissed" {
		if (guest.status === "suspended" || guest.status === "dismissed") return guest.status;
		return guest.teardownReason === "host" ? "suspended" : "dismissed";
	}

	function buildInactiveGuestRecord(guest: GuestInfo): GuestInfo {
		return {
			...guest,
			status: resolveInactiveGuestStatus(guest),
			ready: false,
			submitKey: submitKeyForGuestType(guest.type),
			teardownReason: undefined,
		};
	}

	function captureFinalCodexSessionId(guest: GuestInfo) {
		if (guest.type === "codex" && !guest.sessionId) {
			const candidate = findCodexSessionCandidate(guest, normalizePath(guest.workspaceDir));
			if (candidate) {
				claimGuestSessionId(guest, candidate.sessionId);
			}
		}
		cancelCodexSessionScan(guest.name);
	}

	function removeGuestFromDiscussion(name: string) {
		const discId = guestToDiscussion.get(name);
		if (!discId) return;
		const disc = discussions.get(discId);
		if (!disc) {
			guestToDiscussion.delete(name);
			return;
		}
		cleanupDiscussion(discId, disc);
	}

	function reactivateArchivedDiscussions() {
		for (const [discId, discussion] of Array.from(archivedDiscussions.entries())) {
			if (discussion.stage === "done") continue;
			if (!guests.has(discussion.guestA) || !guests.has(discussion.guestB)) continue;
			archivedDiscussions.delete(discId);
			discussions.set(discId, discussion);
			guestToDiscussion.set(discussion.guestA, discId);
			guestToDiscussion.set(discussion.guestB, discId);
		}
	}

	function beginGuestDismissal(guest: GuestInfo, teardownReason: GuestTeardownReason): Promise<void> {
		const waitForExit = ensureGuestExitWaiter(guest);
		if (guest.status === "dismissing") {
			guest.teardownReason = guest.teardownReason || teardownReason;
			return waitForExit;
		}
		guest.teardownReason = teardownReason;
		captureFinalCodexSessionId(guest);
		guest.status = "dismissing";
		removeGuestFromDiscussion(guest.name);
		writeGuestRuntimeFile(guest);
		persistSalonState();
		// Interrupt first, then exit the shell explicitly so the wrapper can report the final session id.
		tmux(["send-keys", "-t", guest.paneId, "C-c"]);
		tmux(["send-keys", "-t", guest.paneId, "C-c"]);
		tmux(["send-keys", "-t", guest.paneId, "-l", "exit"]);
		tmux(["send-keys", "-t", guest.paneId, "Enter"]);
		return waitForExit;
	}

	function flushQueuedGuestMessages(guest: GuestInfo) {
		const queued = queuedGuestMessages.get(guest.name);
		if (!queued?.length) return;
		queuedGuestMessages.delete(guest.name);
		for (const item of queued) {
			sayToGuest(guest, item.message, item.from);
		}
	}

	function sayToGuest(guest: GuestInfo, message: string, from = "host") {
		if (!guest.ready) {
			const queued = queuedGuestMessages.get(guest.name) || [];
			queued.push({ message, from });
			queuedGuestMessages.set(guest.name, queued);
			return;
		}

		const prefix = `[${from}]: `;
		if (message.length <= MSG_LENGTH_THRESHOLD) {
			sendKeys(guest.paneId, `${prefix}${message}`, guest.submitKey);
		} else {
			// Long messages: write to file, send short reference via send-keys
			const exchangeDir = join(salonDir, "exchange");
			mkdirSync(exchangeDir, { recursive: true });
			const msgFile = join(exchangeDir, `${++msgFileCounter}_${safeLabelForFilename(from)}.md`);
			writeFileSync(msgFile, message);
			sendKeys(guest.paneId, `${prefix}Read ${msgFile} and respond.`, guest.submitKey);
		}
	}

	// ── Discussion state handler ──────────────────────────────────────
	function handleDiscussionMessage(from: string, content: string) {
		const discId = guestToDiscussion.get(from);
		if (!discId) return false;

		const disc = discussions.get(discId);
		if (!disc) return false;

		// Collect response for current round
		disc.currentRound.responses.set(from, content);

		// Wait for both guests
		if (!disc.currentRound.responses.has(disc.guestA) || !disc.currentRound.responses.has(disc.guestB)) {
			const other = from === disc.guestA ? disc.guestB : disc.guestA;
			pi.sendUserMessage(`[salon] "${disc.topic}" — ${from} has responded, waiting for ${other}.`, { deliverAs: "followUp" });
			return true;
		}

		// Both responded — process the round
		const responseA = disc.currentRound.responses.get(disc.guestA)!;
		const responseB = disc.currentRound.responses.get(disc.guestB)!;
		disc.rounds.push(disc.currentRound);
		const roundNum = disc.rounds.length;

		if (disc.stage === "exploring") {
			// First round done — move to debating
			disc.stage = "debating";

			pi.sendUserMessage(`[salon] "${disc.topic}" — both guests have given initial proposals (round ${roundNum}). Cross-review starting.`, { deliverAs: "followUp" });

			// Cross-share for review
			const guestA = guests.get(disc.guestA)!;
			const guestB = guests.get(disc.guestB)!;
			sayToGuest(guestA, responseB, disc.guestB);
			sayToGuest(guestB, responseA, disc.guestA);

			disc.currentRound = { responses: new Map() };
			persistSalonState();
			return true;
		}

		if (disc.stage === "debating") {
			// Deliver both responses to host — host decides what to do next via advance_discussion
			pi.sendUserMessage(
				`[salon] "${disc.topic}" — round ${roundNum} complete.\n\n` +
				`[${disc.guestA}]: ${responseA}\n\n` +
				`[${disc.guestB}]: ${responseB}\n\n` +
				`Review both responses. Use advance_discussion to decide: "continue" (another debate round), "synthesize" (move to synthesis), or "ask_user" (escalate open questions to the user).`,
				{ deliverAs: "followUp" },
				);
				disc.currentRound = { responses: new Map() };
				persistSalonState();
				return true;
			}

		if (disc.stage === "synthesizing") {
			// Guests reviewed the host's synthesis — deliver feedback to host
			pi.sendUserMessage(
				`[salon] "${disc.topic}" — guests have reviewed your synthesis.\n\n` +
				`[${disc.guestA}]: ${responseA}\n\n` +
				`[${disc.guestB}]: ${responseB}\n\n` +
				`If both guests approve, use finalize_discussion to complete. Otherwise revise and submit_synthesis again.`,
				{ deliverAs: "followUp" },
				);
				disc.currentRound = { responses: new Map() };
				persistSalonState();
				return true;
			}

		return false;
	}

	function buildDiscussionSummary(disc: Discussion): string {
		const parts: string[] = [];
		for (let i = 0; i < disc.rounds.length; i++) {
			const round = disc.rounds[i];
			const label = i === 0 ? "Initial proposals" : `Round ${i + 1}`;
			parts.push(`── ${label} ──`);
			const a = round.responses.get(disc.guestA);
			const b = round.responses.get(disc.guestB);
			if (a) parts.push(`[${disc.guestA}]: ${a}`);
			if (b) parts.push(`[${disc.guestB}]: ${b}`);
			parts.push("");
		}
		return parts.join("\n");
	}

	function buildRecoveredSalonSummary(): string | undefined {
		return formatRecoveredSalonSummary({
			salonInstance: SALON_INSTANCE,
			workDir,
			activeGuests: Array.from(guests.values()),
			suspendedGuests: Array.from(dismissedGuests.values()).filter((guest) => guest.status === "suspended"),
			dismissedGuests: Array.from(dismissedGuests.values()).filter((guest) => guest.status === "dismissed"),
			activeDiscussions: Array.from(discussions.values()).map((discussion) => ({
				topic: discussion.topic,
				stage: discussion.stage,
				completedRounds: discussion.rounds.length,
				guestA: discussion.guestA,
				guestB: discussion.guestB,
				awaiting: [discussion.guestA, discussion.guestB].filter((guestName) => !discussion.currentRound.responses.has(guestName)),
			})),
			archivedPendingDiscussions: Array.from(archivedDiscussions.values())
				.filter((discussion) => discussion.stage !== "done")
				.map((discussion) => ({
					topic: discussion.topic,
					stage: discussion.stage,
					completedRounds: discussion.rounds.length,
					guestA: discussion.guestA,
					guestB: discussion.guestB,
				})),
		});
	}

	function resumeInactiveGuest(name: string): GuestInfo {
		name = sanitizeGuestName(name);
		const dismissed = dismissedGuests.get(name);
		if (!dismissed) {
			const available = Array.from(dismissedGuests.keys());
			throw new Error(`Guest '${name}' not found in suspended/dismissed list. Available: ${available.length ? available.join(", ") : "none"}`);
		}
		if (!dismissed.sessionId) {
			throw new Error(`Guest '${name}' has no saved session ID. Must invite as new guest.`);
		}
		if (guests.has(name)) {
			throw new Error(`Guest '${name}' is already active in the salon.`);
		}

		cancelCodexSessionScan(name);
		const resumeWorkDir = dismissed.workspaceDir || workDir;
		const paneId = spawnPane(resumeWorkDir);
		if (!paneId) throw new Error("Failed to create tmux pane");

		const guest: GuestInfo = {
			name: dismissed.name,
			type: dismissed.type,
			paneId,
			submitKey: submitKeyForGuestType(dismissed.type),
			sessionId: dismissed.sessionId,
			nonce: dismissed.nonce,
			startedAt: Date.now(),
			status: "active",
			workspaceDir: resumeWorkDir,
			ready: false,
		};
		guests.set(name, guest);
		dismissedGuests.delete(name);
		if (guest.sessionId) claimedSessionIds.add(guest.sessionId);
		queuedGuestMessages.delete(name);
		writeGuestRuntimeFile(guest);

		const instructionsFile = join(guestDir, `${name}.instructions`);
		// Instructions file should still exist from the original invite
		if (!existsSync(instructionsFile)) {
			writeFileSync(instructionsFile, buildGuestInstructions(guest.nonce));
		}

		let cmd: string;
		if (dismissed.type === "codex") {
			cmd = joinShellArgs(["codex", "resume", dismissed.sessionId!, "-c", `model_instructions_file=${instructionsFile}`]);
		} else {
			const exchangeDir = join(salonDir, "exchange");
			mkdirSync(exchangeDir, { recursive: true });
			cmd = joinShellArgs([
				"claude",
				"--resume",
				dismissed.sessionId!,
				"--append-system-prompt-file",
				instructionsFile,
				"--add-dir",
				exchangeDir,
			]);
		}

		// Wrapper script: run agent, capture session ID after exit, notify host
		const wrapperScript = join(guestDir, `${name}.wrapper.sh`);
		writeFileSync(wrapperScript, buildGuestExitWrapperScript({
			name,
			salonDir,
			workDir: resumeWorkDir,
			command: cmd,
			initialSessionId: dismissed.sessionId,
		}));
		chmodSync(wrapperScript, 0o755);

		sendKeys(paneId, `exec bash ${shellQuote(wrapperScript)}`);
		reactivateArchivedDiscussions();
		persistSalonState();
		return guest;
	}

	function cleanupDiscussion(discId: string, disc: Discussion) {
		guestToDiscussion.delete(disc.guestA);
		guestToDiscussion.delete(disc.guestB);
		discussions.delete(discId);
		// Archive the discussion after removing it from the active set so shutdown snapshots do not lose context.
		archivedDiscussions.set(discId, disc);
	}

	// ── Tools ──────────────────────────────────────────────────────────
	pi.registerTool({
		name: "invite_guest",
		label: "Invite Guest",
		description:
			"Invite a guest agent (Claude Code or Codex CLI) to the salon. " +
			"Use 'claude' for analysis, planning, code review, research, discussion. " +
			"Use 'codex' for code generation, making edits, executing changes.",
		promptSnippet: "Invite a Claude Code or Codex CLI guest to the salon",
		promptGuidelines: [
			"Invite 'claude' for analysis, planning, code review, research, discussion",
			"Invite 'codex' for code generation, edits, implementations",
			"Don't invite guests for simple questions you can answer directly",
			"Invite multiple guests when tasks benefit from parallel work or different perspectives",
		],
		parameters: Type.Object({
			type: Type.Union([Type.Literal("claude"), Type.Literal("codex")], { description: "Guest type" }),
			name: Type.String({ description: "Unique guest name, e.g. 'researcher', 'reviewer'" }),
		}),
		async execute(_id, params: any) {
			const guest = inviteGuest(params.name, params.type, workDir, salonDir, guestDir);
			scanCodexSessionId(guest);
				persistSalonState();

				return {
					content: [{ type: "text" as const, text: `Invited ${params.type} guest '${params.name}' to the salon. Messages will queue until the guest reports ready.` }],
					details: {},
				};
			},
		});

	pi.registerTool({
		name: "discuss",
		label: "Start Discussion",
		description:
			"Start a structured discussion on a topic. Invites two guests (default: one Claude Code + one Codex CLI for diverse perspectives) " +
			"who independently explore the topic, then cross-review each other's proposals. The host synthesizes at the end.",
		promptSnippet: "Start a structured discussion between two guests (default: claude + codex for cognitive diversity)",
		promptGuidelines: [
			"Use discuss for open-ended questions: architecture, design decisions, migration strategies, planning",
			"Default to discuss over answering alone for questions where you're not fully certain or where tradeoffs are non-obvious",
			"Discussions use one claude + one codex by default — different models produce genuinely different perspectives. Override only when there's a reason.",
			"After the discussion completes, synthesize the proposals and reviews into a final recommendation",
		],
		parameters: Type.Object({
			topic: Type.String({ description: "Brief topic label for tracking the discussion" }),
			message: Type.String({ description: "The message to send to both guests — describe the task, provide context, ask the question. You decide how to frame it." }),
			guest_a_type: Type.Optional(Type.Union([Type.Literal("claude"), Type.Literal("codex")], {
				description: "Type for guest A (default: claude)",
			})),
			guest_b_type: Type.Optional(Type.Union([Type.Literal("claude"), Type.Literal("codex")], {
				description: "Type for guest B (default: codex)",
			})),
			guest_a_name: Type.Optional(Type.String({ description: "Name for guest A (default: auto-generated)" })),
			guest_b_name: Type.Optional(Type.String({ description: "Name for guest B (default: auto-generated)" })),
		}),
		async execute(_id, params: any) {
			const typeA = params.guest_a_type || "claude";
			const typeB = params.guest_b_type || "codex";
			const discId = `disc_${Date.now()}`;
			const nameA = params.guest_a_name || `${discId}_a`;
			const nameB = params.guest_b_name || `${discId}_b`;

			// Invite both guests — heterogeneous by default
			const guestA = inviteGuest(nameA, typeA, workDir, salonDir, guestDir);
			const guestB = inviteGuest(nameB, typeB, workDir, salonDir, guestDir);
			scanCodexSessionId(guestA);
			scanCodexSessionId(guestB);

			// Create discussion state
			const disc: Discussion = {
				id: discId,
				topic: params.topic,
				guestA: nameA,
				guestB: nameB,
				stage: "exploring",
				rounds: [],
				currentRound: { responses: new Map() },
			};
			discussions.set(discId, disc);
			guestToDiscussion.set(nameA, discId);
			guestToDiscussion.set(nameB, discId);
			pi.setSessionName(`salon: ${params.topic}`);
			persistSalonState();

				// Messages are queued until each guest reports ready.
				sayToGuest(guestA, params.message);
				sayToGuest(guestB, params.message);

			return {
				content: [{ type: "text" as const, text: `Discussion started on "${params.topic}" with guests '${nameA}' and '${nameB}'. Both are exploring independently. I'll report progress as it happens.` }],
				details: {},
			};
		},
	});

	pi.registerTool({
		name: "advance_discussion",
		label: "Advance Discussion",
		description:
			"Decide how to proceed with a discussion after reviewing a debate round. " +
			"Use 'continue' for another round of debate, 'synthesize' to move to synthesis, or 'ask_user' to escalate open questions.",
		promptSnippet: "Advance a discussion: continue debating, move to synthesis, or ask the user",
		parameters: Type.Object({
			topic: Type.String({ description: "The discussion topic" }),
			action: Type.Union([Type.Literal("continue"), Type.Literal("synthesize"), Type.Literal("ask_user")], {
				description: "continue = another debate round, synthesize = you're ready to write a synthesis, ask_user = there are open questions only the user can answer",
			}),
			message: Type.Optional(Type.String({ description: "For 'continue': optional guidance to guests. For 'ask_user': the questions to ask." })),
		}),
		async execute(_id, params: any) {
			let targetDisc: Discussion | undefined;
			let targetId: string | undefined;
			for (const [id, disc] of discussions) {
				if (disc.topic === params.topic && disc.stage === "debating") {
					targetDisc = disc;
					targetId = id;
					break;
				}
			}
			if (!targetDisc || !targetId) {
				throw new Error(`No active discussion in debating stage for topic "${params.topic}"`);
			}

			const guestA = guests.get(targetDisc.guestA);
			const guestB = guests.get(targetDisc.guestB);
			if (!guestA || !guestB) throw new Error("Discussion guests no longer available");

			if (params.action === "continue") {
				// Send each guest the other's latest response for another round
				const lastRound = targetDisc.rounds[targetDisc.rounds.length - 1];
				const lastA = lastRound?.responses.get(targetDisc.guestA) || "";
				const lastB = lastRound?.responses.get(targetDisc.guestB) || "";
				if (params.message) {
					sayToGuest(guestA, `${params.message}\n\n${lastB}`, targetDisc.guestB);
					sayToGuest(guestB, `${params.message}\n\n${lastA}`, targetDisc.guestA);
				} else {
					sayToGuest(guestA, lastB, targetDisc.guestB);
					sayToGuest(guestB, lastA, targetDisc.guestA);
				}
				return {
					content: [{ type: "text" as const, text: `Debate continues — round ${targetDisc.rounds.length + 1} started.` }],
					details: {},
				};
			}

			if (params.action === "synthesize") {
				targetDisc.stage = "synthesizing";
				persistSalonState();
				const summary = buildDiscussionSummary(targetDisc);
				return {
					content: [{ type: "text" as const, text: `Discussion "${params.topic}" moved to synthesis stage. Write your synthesis and use submit_synthesis.\n\n${summary}` }],
					details: {},
				};
			}

			if (params.action === "ask_user") {
				targetDisc.stage = "done";
				const summary = buildDiscussionSummary(targetDisc);
				cleanupDiscussion(targetId, targetDisc);
				persistSalonState();
				return {
					content: [{ type: "text" as const, text: `Discussion paused. Open questions for the user:\n\n${params.message || "(no specific questions provided)"}\n\nFull discussion:\n${summary}` }],
					details: {},
				};
			}

			throw new Error(`Unknown action: ${params.action}`);
		},
	});

	pi.registerTool({
		name: "submit_synthesis",
		label: "Submit Synthesis",
		description:
			"Submit your synthesis of a discussion to both guests for confirmation. " +
			"Use this after the salon tells you to synthesize. Guests will review and either approve or suggest revisions.",
		promptSnippet: "Submit discussion synthesis for guest confirmation",
		parameters: Type.Object({
			topic: Type.String({ description: "The discussion topic (must match an active discussion)" }),
			synthesis: Type.String({ description: "Your synthesis text" }),
		}),
		async execute(_id, params: any) {
			// Find the discussion in synthesizing stage
			let targetDisc: Discussion | undefined;
			let targetId: string | undefined;
			for (const [id, disc] of discussions) {
				if (disc.topic === params.topic && disc.stage === "synthesizing") {
					targetDisc = disc;
					targetId = id;
					break;
				}
			}
			if (!targetDisc || !targetId) {
				throw new Error(`No discussion in synthesizing stage for topic "${params.topic}"`);
			}

			const guestA = guests.get(targetDisc.guestA);
			const guestB = guests.get(targetDisc.guestB);
			if (!guestA || !guestB) throw new Error("Discussion guests no longer available");

			// Send synthesis to both guests for review
			const reviewPrompt = `The host has synthesized the discussion on "${params.topic}". Please review this synthesis. If you agree it's accurate and complete, say so. If you have objections or corrections, state them clearly.\n\n${params.synthesis}`;
			sayToGuest(guestA, reviewPrompt);
			sayToGuest(guestB, reviewPrompt);

			return {
				content: [{ type: "text" as const, text: `Synthesis sent to both guests for confirmation. Waiting for their review.` }],
				details: {},
			};
		},
	});

	pi.registerTool({
		name: "finalize_discussion",
		label: "Finalize Discussion",
		description: "Mark a discussion as complete after guests have approved the synthesis.",
		promptSnippet: "Finalize a discussion after synthesis is approved",
		parameters: Type.Object({
			topic: Type.String({ description: "The discussion topic" }),
		}),
		async execute(_id, params: any) {
			let targetDisc: Discussion | undefined;
			let targetId: string | undefined;
			for (const [id, disc] of discussions) {
				if (disc.topic === params.topic && disc.stage === "synthesizing") {
					targetDisc = disc;
					targetId = id;
					break;
				}
			}
			if (!targetDisc || !targetId) {
				throw new Error(`No discussion in synthesizing stage for topic "${params.topic}"`);
			}
			targetDisc.stage = "done";
			cleanupDiscussion(targetId, targetDisc);
			persistSalonState();
			return {
				content: [{ type: "text" as const, text: `Discussion "${params.topic}" finalized.` }],
				details: {},
			};
		},
	});

	pi.registerTool({
		name: "say_to_guest",
		label: "Say to Guest",
		description: "Say something to a guest in the salon. Their response arrives automatically.",
		promptSnippet: "Say something to a guest",
		parameters: Type.Object({
			name: Type.String({ description: "Guest name" }),
			message: Type.String({ description: "What to say" }),
		}),
		async execute(_id, params: any) {
			const guest = guests.get(params.name);
			if (!guest) throw new Error(`Guest '${params.name}' is not in the salon`);
			if (guest.status !== "active") throw new Error(`Guest '${params.name}' is not accepting new messages right now.`);
			sayToGuest(guest, params.message);
			return {
				content: [{ type: "text" as const, text: `Said to '${params.name}'.` }],
				details: {},
			};
		},
	});

	pi.registerTool({
		name: "list_guests",
		label: "List Guests",
		description: "List all guests currently in the salon, with their status (working/input/idle/new).",
		promptSnippet: "List guests in the salon with status",
		parameters: Type.Object({}),
		async execute() {
			if (guests.size === 0) return { content: [{ type: "text" as const, text: "No guests in the salon." }], details: {} };
			const lines = Array.from(guests.values()).map((g) => {
				const status = getGuestDisplayStatus(g);
				const discId = guestToDiscussion.get(g.name);
				const disc = discId ? discussions.get(discId) : undefined;
				const discLabel = disc ? ` [discussing: ${disc.stage}]` : "";
				return `${g.name} (${g.type}) ${status}${discLabel} @ ${g.workspaceDir}`;
			});
			return { content: [{ type: "text" as const, text: lines.join("\n") }], details: {} };
		},
	});

	pi.registerTool({
		name: "dismiss_guest",
		label: "Dismiss Guest",
		description: "Gracefully dismiss a guest from the salon.",
		promptSnippet: "Dismiss a guest from the salon",
		parameters: Type.Object({
			name: Type.String({ description: "Guest name to dismiss" }),
		}),
		async execute(_id, params: any) {
			const guest = guests.get(params.name);
			if (!guest) throw new Error(`Guest '${params.name}' is not in the salon`);
			if (guest.status === "dismissing") {
				return { content: [{ type: "text" as const, text: `Guest '${params.name}' is already being dismissed.` }], details: {} };
			}
			beginGuestDismissal(guest, "user");
			return { content: [{ type: "text" as const, text: `Guest '${params.name}' is leaving the salon.` }], details: {} };
		},
	});

	pi.registerTool({
		name: "resume_guest",
		label: "Resume Guest",
		description: "Resume a previously suspended or dismissed guest with their full conversation history intact.",
		promptSnippet: "Resume a suspended or dismissed guest with their previous session",
		parameters: Type.Object({
			name: Type.String({ description: "Name of the suspended or dismissed guest to resume" }),
		}),
		async execute(_id, params: any) {
			params.name = sanitizeGuestName(params.name);
			const inactive = dismissedGuests.get(params.name);
			const guest = resumeInactiveGuest(params.name);

			return {
				content: [{ type: "text" as const, text: `Resumed guest '${params.name}' (${inactive?.type || guest.type}) with previous session. Full conversation history intact.` }],
				details: {},
			};
		},
	});

	pi.registerTool({
		name: "resume_all",
		label: "Resume All Suspended Guests",
		description: "Resume all suspended guests whose sessions were auto-paused when the host exited.",
		promptSnippet: "Resume all suspended guests",
		parameters: Type.Object({}),
		async execute() {
			const suspendedGuests = Array.from(dismissedGuests.values()).filter((guest) => guest.status === "suspended");
			if (suspendedGuests.length === 0) {
				return { content: [{ type: "text" as const, text: "No suspended guests are waiting to be resumed." }], details: {} };
			}

			const resumed: string[] = [];
			const failed: string[] = [];
			for (const guest of suspendedGuests) {
				try {
					resumeInactiveGuest(guest.name);
					resumed.push(guest.name);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					failed.push(`${guest.name}: ${message}`);
				}
			}

			const parts: string[] = [];
			if (resumed.length > 0) {
				parts.push(`Resumed suspended guests: ${resumed.join(", ")}.`);
			}
			if (failed.length > 0) {
				parts.push(`Failed to resume: ${failed.join(" | ")}`);
			}

			return {
				content: [{ type: "text" as const, text: parts.join(" ") || "No suspended guests were resumed." }],
				details: {},
			};
		},
	});

	// ── Host system prompt ────────────────────────────────────────────
	pi.on("before_agent_start", (event) => {
		const hostPreamble =
`You are the host of a salon — a collaborative coding workspace built on pi, a coding agent harness. You are a facilitator who coordinates guest agents (Claude Code, Codex CLI) working in parallel tmux panes.

The user sits with you. They can talk to you directly, or switch to any guest's pane to interact privately. Your job is to make the overall collaboration productive.

# Your role as host

You are a host, not a developer. Your value is in:
- Understanding the user's intent and framing the right questions
- Choosing which guests to involve and how to brief them
- Facilitating productive discussion between guests
- Synthesizing results and presenting recommendations

You MAY use the read tool ONLY on documentation files (README, CHANGELOG, AGENTS.md, CLAUDE.md, docs/, etc.).
You MUST NOT:
- Read source code files (.ts, .js, .rs, .py, .go, .sh, etc.)
- Use bash to grep, find, cat, head, tail, or wc on source files
- Use bash to explore directory structures of source code
- Run any command whose purpose is to understand implementation details
These are the guests' job. Delegate to a guest instead.

# When to invite guests

Invite a single guest (invite_guest + say_to_guest) when:
- The task is clear and self-contained — you know exactly what to delegate
- codex for code changes, claude for analysis

Start a discuss (discuss tool) when:
- The task involves design decisions, architecture, or planning
- You want diverse perspectives before committing to an approach
- The user explicitly asks for discussion or debate
- The question is open-ended or has non-obvious tradeoffs

Default to discuss for any question about architecture, migration, refactoring, or design. Different models (claude + codex) produce genuinely different perspectives — that's the whole point of the salon.

When you need two guests to explore a topic, ALWAYS use the discuss tool. Never manually orchestrate a multi-guest discussion by calling invite_guest + say_to_guest yourself — the discuss tool handles the full flow (independent exploration → cross-review → synthesis) automatically.

## Guest type characteristics
Based on observed behavior patterns:

- **Claude Code guests** tend to excel at **strategic / macro-level thinking**: holistic evaluation frameworks, ecosystem positioning, meta-analysis during cross-review, and identifying architectural insights. They tend to be more generous in assessment and better at "finding problems within affirmation."

- **Codex CLI guests** tend to excel at **engineering detail and empirical verification**: actually running builds/tests, catching specific risks (shell injection, config safety, test coverage gaps), rigorous wording, and grounded competitive analysis. They tend to be more conservative in assessment and better at "finding highlights within skepticism."

These are complementary perspectives. Use this to guide guest selection:
- For architecture, strategy, or positioning → prefer claude
- For implementation, verification, or security review → prefer codex
- For open-ended evaluation → use discuss (one of each) to get both perspectives

# How to be a good host

## Communicating with guests
Guests are capable coding agents — they can explore codebases, read files, and understand context on their own.

When sending questions for discussion (discuss tool, open-ended exploration):
- Pass the user's question as-is. Don't rewrite, decompose, or add sub-questions.
- Only add context the guest genuinely can't discover from the codebase.
- Never pre-structure their thinking.

When delegating execution tasks (invite_guest + say_to_guest, implementation work):
- Start with WHAT: what is the project, what are we doing
- Then WHY: why are we doing this, what problem does it solve, what's the current limitation
- Then HOW: the specific task to execute
- A guest receiving an execution task should understand the full intent, not just a list of file changes.

When facilitating discussion:
- Ask open-ended questions that draw out deeper thinking, not yes/no questions
- Challenge assumptions — "what if the codebase grows 10x?" or "what are you not considering?"
- If a guest's response is shallow, push back: "can you go deeper on the tradeoffs?"

## Discussion flow
The discuss tool automates the full flow. Your responsibilities at each stage:

1. **Exploring**: guests work independently. You wait.
2. **Debating**: guests cross-review. After each round, you receive both responses and decide:
   - advance_discussion with "continue" → another round (you can add guidance)
   - advance_discussion with "synthesize" → move to synthesis
   - advance_discussion with "ask_user" → escalate open questions to the user
3. **Synthesizing**: write your synthesis, then call submit_synthesis. Guests review it.
4. **Confirmation**: if guests approve, call finalize_discussion. If they have objections, revise and submit_synthesis again.

You judge when the debate has converged enough to synthesize. Don't rush — if guests are still raising substantive new points, continue the debate.

## Waiting for guests
Guest responses are delivered to you automatically — you do NOT need to poll, check, or call list_guests in a loop. After sending a task via say_to_guest or starting a discuss, simply finish your current response. When a guest replies, it will appear as your next input message (e.g. [guest-name]: ...). Do nothing until then.

## Keeping the user informed
- Briefly tell the user what you're doing and why when starting collaboration
- When guest responses arrive, distill the key insights — don't dump raw output
- Present your synthesis with your own judgment, not as a neutral relay

# Message format

Messages from guests arrive as: [guest-name]: content
Discussion status updates arrive as: [salon] content

When these appear, process them thoughtfully — don't just echo them to the user. Add your perspective, context, or next steps.

`;
		// Replace pi's default identity line with salon context
		const basePrompt = event.systemPrompt.replace(
			/^You are an expert coding assistant operating inside pi, a coding agent harness\. You help users by reading files, executing commands, editing code, and writing new files\.\n*/,
			"",
		);
		const resumeSummary = pendingResumeSummary
			? `\n# Recovered salon state after resume\n${pendingResumeSummary}\n`
			: "";
		pendingResumeSummary = undefined;
		return { systemPrompt: hostPreamble + resumeSummary + basePrompt };
	});

	// ── Receive guest responses via Unix socket ──────────────────────
	const socketPath = join(salonDir, "salon.sock");
	let messageServer: Server | undefined;

	function restoreSalonSession(ctx: { sessionManager: { getBranch(): Array<{ type?: string; customType?: string; data?: unknown }> } }) {
		clearRuntimeState();
		restoreMsgFileCounter();
		const entries = ctx.sessionManager.getBranch();
		let restoredSnapshot = false;
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i];
			if (entry.type === "custom" && entry.customType === SALON_STATE_ENTRY_TYPE && isSalonStateSnapshot(entry.data)) {
				restoreSalonState(entry.data);
				restoredSnapshot = true;
				break;
			}
		}
		scheduleMissingCodexSessionScans();
		if (restoredSnapshot) {
			pendingResumeSummary = buildRecoveredSalonSummary();
		}
	}

	function openSalonMessageServer() {
		messageServer?.close();
		messageServer = startMessageServer(socketPath, (msg) => {
			// Handle guest lifecycle events
			if (msg.from === "_system" && msg.content.startsWith("guest_ready:")) {
				const name = msg.content.slice("guest_ready:".length);
				const guest = guests.get(name);
				if (guest && !guest.ready) {
					guest.ready = true;
					writeGuestRuntimeFile(guest);
					flushQueuedGuestMessages(guest);
				}
				return;
			}

			if (msg.from === "_system" && msg.content.startsWith("guest_ready_timeout:")) {
				const name = msg.content.slice("guest_ready_timeout:".length);
				const queuedCount = queuedGuestMessages.get(name)?.length || 0;
				const queuedHint = queuedCount > 0 ? ` ${queuedCount} queued message(s) are still pending.` : "";
				pi.sendUserMessage(
					`[salon] Guest '${name}' did not report ready within 30 seconds.${queuedHint}`,
					{ deliverAs: "followUp" },
				);
				return;
			}

			if (msg.from === "_system" && msg.content.startsWith("guest_exited:")) {
				// Format: guest_exited:<name>:<sessionId>
				const parts = msg.content.slice("guest_exited:".length).split(":");
				const name = parts[0];
				const sessionId = parts[1] || undefined;
				const guest = guests.get(name) || dismissedGuests.get(name);
				if (guest) {
					cancelCodexSessionScan(name);
					if (!guest.sessionId && sessionId) {
						guest.sessionId = sessionId;
					}
					if (guest.sessionId) {
						claimedSessionIds.add(guest.sessionId);
					}
					const droppedQueuedCount = queuedGuestMessages.get(name)?.length || 0;
					const inactiveGuest = buildInactiveGuestRecord(guest);
					guests.delete(name);
					dismissedGuests.set(name, inactiveGuest);
					queuedGuestMessages.delete(name);
					removeGuestFromDiscussion(name);
					writeGuestRuntimeFile(inactiveGuest);
					persistSalonState();
					settleGuestExitWaiter(name);
					const resumeHint = inactiveGuest.sessionId ? ` Session saved — use resume_guest to bring them back.` : "";
					const queueHint = droppedQueuedCount > 0 ? ` ${droppedQueuedCount} queued message(s) were never delivered.` : "";
					const exitLabel = inactiveGuest.status === "suspended" ? "has been suspended" : "has left the salon";
					pi.sendUserMessage(`[salon] Guest '${name}' ${exitLabel}.${resumeHint}${queueHint}`, { deliverAs: "followUp" });
				}
				return;
			}

			const handled = handleDiscussionMessage(msg.from, msg.content);
			if (!handled) {
				pi.sendUserMessage(`[${msg.from}]: ${msg.content}`, { deliverAs: "followUp" });
			}
		});
	}

	async function teardownSalonSession(options: { killTmuxSession: boolean }) {
		const exitWaits: Promise<void>[] = [];
		for (const guest of guests.values()) {
			if (guest.status === "active") {
				exitWaits.push(beginGuestDismissal(guest, "host"));
			} else if (guest.status === "dismissing") {
				guest.teardownReason = guest.teardownReason || "host";
				exitWaits.push(ensureGuestExitWaiter(guest));
			}
		}

		await Promise.race([
			Promise.all(exitWaits),
			new Promise<void>((resolve) => setTimeout(resolve, 5000)),
		]);

		for (const [name, guest] of Array.from(guests.entries())) {
			if (guest.status !== "dismissing") continue;
			settleGuestExitWaiter(name);
			if (!guest.sessionId) continue;
			guests.delete(name);
			const inactiveGuest = buildInactiveGuestRecord(guest);
			dismissedGuests.set(name, inactiveGuest);
			writeGuestRuntimeFile(inactiveGuest);
		}
		persistSalonState();

		messageServer?.close();
		if (existsSync(socketPath)) unlinkSync(socketPath);
		if (options.killTmuxSession) {
			tmux(["kill-session", "-t", TMUX_SESSION]);
		}
	}

	pi.on("session_before_switch", async (_event, ctx) => {
		if (ctx.hasUI) {
			ctx.ui.notify("Dismissing active salon guests before switching sessions.", "info");
		}
		await teardownSalonSession({ killTmuxSession: false });
		return { cancel: false };
	});

	pi.on("session_start", (_event, ctx) => {
		restoreSalonSession(ctx);
		openSalonMessageServer();
	});

	pi.on("session_switch", (_event, ctx) => {
		restoreSalonSession(ctx);
		openSalonMessageServer();
	});

	// ── Slash commands ────────────────────────────────────────────────
	pi.registerCommand("guests", {
		description: "List guests in the salon",
		handler: async (_args, ctx) => {
			if (guests.size === 0) {
				ctx.ui.notify("No guests in the salon", "info");
				return;
			}
			const lines = Array.from(guests.values()).map((g) => {
				const status = getGuestDisplayStatus(g);
				const discId = guestToDiscussion.get(g.name);
				const disc = discId ? discussions.get(discId) : undefined;
				const discLabel = disc ? ` [${disc.stage}]` : "";
				return `${g.name} (${g.type}) ${status}${discLabel} @ ${g.workspaceDir}`;
			});
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerCommand("resume", {
		description: "Resume a previous salon session",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				throw new Error("/resume requires an interactive UI session.");
			}

			const currentSessionFile = ctx.sessionManager.getSessionFile();
			const currentSessionPath = currentSessionFile ? resolve(currentSessionFile) : undefined;
			const sessions = listSalonSessions(hostSessionDir).filter((session) => resolve(session.path) !== currentSessionPath);

			if (sessions.length === 0) {
				ctx.ui.notify("No other salon sessions found.", "info");
				return;
			}

			const items: SelectItem[] = sessions.map((session) => ({
				value: session.path,
				label: formatSessionLabel(session.timestamp, session.name),
				description: `${session.guestCount} guests · ${session.discussionCount} discussions`,
			}));

			const selectedPath = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
				const container = new Container();
				container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
				container.addChild(new Text(theme.fg("accent", theme.bold("Resume Salon Session")), 1, 0));

				const selectList = new SelectList(items, Math.min(items.length, 10), {
					selectedPrefix: (text) => theme.fg("accent", text),
					selectedText: (text) => theme.fg("accent", text),
					description: (text) => theme.fg("muted", text),
					scrollInfo: (text) => theme.fg("dim", text),
					noMatch: (text) => theme.fg("warning", text),
				});
				selectList.onSelect = (item) => done(item.value);
				selectList.onCancel = () => done(null);
				container.addChild(selectList);

				container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter resume • esc cancel"), 1, 0));
				container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

				return {
					render: (width) => container.render(width),
					invalidate: () => container.invalidate(),
					handleInput: (data) => {
						selectList.handleInput(data);
						tui.requestRender();
					},
				};
			});

			if (!selectedPath) return;
			await ctx.switchSession(selectedPath);
		},
	});

	// ── Graceful shutdown ─────────────────────────────────────────────
	pi.on("session_shutdown", async () => {
		await teardownSalonSession({ killTmuxSession: true });
	});

	pi.registerCommand("next", {
		description: "Jump to the next guest waiting for input (approval)",
		handler: async (_args, ctx) => {
			for (const [, guest] of guests) {
				if (guest.status !== "active") continue;
				if (detectGuestStatus(guest.paneId) === "input") {
					tmux(["select-pane", "-t", guest.paneId]);
					ctx.ui.notify(`Switched to ${guest.name} (needs input)`, "info");
					return;
				}
			}
			ctx.ui.notify("No guests waiting for input", "info");
		},
	});

	pi.registerCommand("discuss", {
		description: "Start a discussion: /discuss <topic>",
		handler: async (args, _ctx) => {
			const topic = args.trim();
			if (!topic) {
				pi.sendUserMessage("Usage: /discuss <topic to discuss>");
				return;
			}
			// Send as user message so the host LLM processes it naturally
			pi.sendUserMessage(`Please start a discuss on this topic: ${topic}`);
		},
	});
}

export const __test__ = {
	buildGuestExitWrapperScript,
	formatRecoveredSalonSummary,
	sanitizeGuestName,
};
