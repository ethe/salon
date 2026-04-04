/**
 * Salon — a pi extension for multi-agent collaboration.
 *
 * The host (this pi instance) coordinates guest agents
 * (Claude Code / Codex CLI) in tmux panes.
 *
 * Run: pi --extension ./src/extension.ts
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { createConnection, createServer, type Server } from "node:net";
import type { GuestRuntime, GuestStatus } from "./runtime.js";
import { TmuxBackend } from "./tmux-backend.js";
import {
	createGuestQuantState,
	resolveClaudeSessionLogPath,
	updateGuestQuantState as parseGuestQuantState,
	type GuestQuantState,
} from "./session-parser.js";
import {
	type Discussion, type DiscussionStage, type DiscussionCommand,
	type PersistedDiscussion, type PersistedDiscussionRound,
	serializeDiscussion, deserializeDiscussion,
	handleMessage as discussionHandleMessage,
	advance as discussionAdvance, type AdvanceAction,
	submitSynthesisToGuests, finalize as discussionFinalize,
	buildSummary as buildDiscussionSummary,
} from "./discussion.js";

const SALON_INSTANCE = process.env.SALON_INSTANCE || `default-${randomUUID().slice(0, 8)}`;
const TMUX_SESSION = process.env.SALON_TMUX_SESSION || `salon-${SALON_INSTANCE}`;
const SALON_AUTONOMOUS = process.env.SALON_AUTONOMOUS === "1";
const SALON_TASK_FILE = process.env.SALON_TASK_FILE;
const SALON_RESULT_FILE = process.env.SALON_RESULT_FILE;
const SALON_STATE_ENTRY_TYPE = "salon_state";
const SALON_STATE_VERSION = 1;
const SALON_STATUS_MESSAGE_TYPE = "salon-status";
const SALON_REPORT_REGEX = /\s*<SALON_REPORT>\s*\n?([\s\S]*?)<\/SALON_REPORT>\s*$/;
type GuestType = "claude" | "codex";
type GuestTeardownReason = "host" | "user";
type GuestLifecycleStatus = "active" | "dismissing" | "suspended" | "dismissed";

interface GuestRuntimeFile {
	name: string;
	type: GuestType;
	paneId: string;
	sessionId?: string;
	nonce?: string;
	startedAt?: string;
	workspaceDir?: string;
	dangerouslySkipPermissions?: boolean;
}

interface GuestRecord {
	name: string;
	type: GuestType;
	sessionId?: string;
	nonce?: string;
	startedAt?: number;
	lifecycleStatus: GuestLifecycleStatus;
	workspaceDir: string;
	dangerouslySkipPermissions?: boolean;
	teardownReason?: GuestTeardownReason;
}

interface GuestRuntimeHandle {
	runtimeId: string;
	ready: boolean;
	eventStatus?: "working" | "idle";
}

type Guest = GuestRecord & GuestRuntimeHandle;

interface ResolveDiscussionGuestOptions {
	name?: string;
	inviteType: GuestType;
	expectedType?: GuestType;
	activeGuests: Map<string, Guest>;
	guestDiscussions: Map<string, string>;
	getStatus: (guest: Guest) => string;
	invite: (type: GuestType) => Guest;
}

interface Deferred<T> {
	promise: Promise<T>;
	resolve: (value: T | PromiseLike<T>) => void;
}

// Guests that are not currently active but may still be resumable.
const dismissedGuests = new Map<string, GuestRecord>();

interface PersistedGuestInfo {
	name: string;
	type: GuestType;
	status: GuestLifecycleStatus;
	sessionId?: string;
	nonce?: string;
	startedAt?: string;
	workspaceDir?: string;
	dangerouslySkipPermissions?: boolean;
}

interface SalonStateSnapshot {
	version: typeof SALON_STATE_VERSION;
	guests: Record<string, PersistedGuestInfo>;
	discussions: Record<string, PersistedDiscussion>;
	updatedAt: string;
}

interface AnthropicCacheControl {
	type: string;
	[key: string]: unknown;
}

interface AnthropicTextBlock {
	type: "text";
	text: string;
	cache_control?: AnthropicCacheControl;
}

interface AnthropicImageBlock {
	type: "image";
	source: unknown;
	cache_control?: AnthropicCacheControl;
}

interface AnthropicToolResultBlock {
	type: "tool_result";
	tool_use_id: string;
	content: unknown;
	is_error?: boolean;
	cache_control?: AnthropicCacheControl;
}

type AnthropicCacheableBlock = AnthropicTextBlock | AnthropicImageBlock | AnthropicToolResultBlock;

interface AnthropicOtherBlock {
	type: string;
	[key: string]: unknown;
}

type AnthropicContentBlock = AnthropicCacheableBlock | AnthropicOtherBlock;

interface AnthropicMessagePayload {
	role: string;
	content: string | AnthropicContentBlock[];
}

interface AnthropicProviderPayload {
	system: unknown[];
	messages: AnthropicMessagePayload[];
	[key: string]: unknown;
}

interface SalonReportNewRef {
	kind: string;
	op: string;
	ref: string;
	summary: string;
}

interface SalonReport {
	newRefs: SalonReportNewRef[];
	carryRefs: string[];
}

interface GuestRef {
	id: string;
	kind: string;
	op: string;
	summary: string;
	firstSeen: number;
	lastSeen: number;
	freshness: "active" | "recent" | "historical";
	confidence: "normal" | "stale";
}

interface GuestContextState {
	refs: Map<string, GuestRef>;
	consecutiveMissingReports: number;
	totalResponses: number;
}


const guests = new Map<string, Guest>();
const discussions = new Map<string, Discussion>();
const archivedDiscussions = new Map<string, Discussion>();
// Track which guest belongs to which discussion
const guestToDiscussion = new Map<string, string>();
const guestQuantStates = new Map<string, GuestQuantState>();
const guestContextStates = new Map<string, GuestContextState>();
const claimedSessionIds = new Set<string>();
const activeCodexSessionScans = new Map<string, ReturnType<typeof setTimeout>>();
const queuedGuestMessages = new Map<string, Array<{ message: string; from: string }>>();
const guestExitWaiters = new Map<string, Deferred<void>>();
const usedGuestNames = new Set<string>();
const usedGuestPoolNames = new Set<string>();
const guestNameOrdinals = new Map<string, number>();

const CODEX_SESSION_SCAN_INITIAL_DELAY_MS = 2000;
const CODEX_SESSION_SCAN_INTERVAL_MS = 2000;
const CODEX_SESSION_SCAN_TIMEOUT_MS = 30000;
const CODEX_SESSION_SCAN_MAX_FIRST_LINE_BYTES = 16 * 1024;
const SOCKET_PROBE_TIMEOUT_MS = 250;
const GUEST_CONTEXT_RECENT_MS = 3 * 60 * 1000;
const MAX_GUEST_CONTEXT_REFS = 50;
const GUEST_NAME_POOL = [
	"Euclid",
	"Pythagoras",
	"Democritus",
	"Socrates",
	"Plato",
	"Aristotle",
	"Epicurus",
	"Epictetus",
	"Hypatia",
	"Archimedes",
	"Claudius",
	"Husayn",
	"Muhammad",
	"William",
	"Nicolaus",
	"Andreas",
	"Francis",
	"Galileo",
	"Johannes",
	"Rene",
	"Thomas",
	"Blaise",
	"Robert",
	"Robin",
	"Gottfried",
	"Isaac",
	"John",
	"Christiaan",
	"Edmond",
	"Jakob",
	"Leonhard",
	"Carolus",
	"David",
	"Michel",
	"Joseph",
	"Immanuel",
	"Antoine",
	"Alessandro",
	"Tom",
	"Michael",
	"Johann",
	"Charles",
	"Charlie",
	"Mary",
	"James",
	"Marie",
	"Ludwig",
	"Louis",
	"Gregor",
	"Soren",
	"Florence",
	"Hermann",
	"Ernst",
	"Friedrich",
	"Henri",
	"Max",
	"Chuck",
	"Jack",
	"Sigmund",
	"Ivan",
	"Chandra",
	"Srinivasa",
	"Dave",
	"Emmy",
	"Bertrand",
	"Ludo",
	"Albert",
	"Niels",
	"Werner",
	"Erwin",
	"Edwin",
	"Kurt",
	"Alan",
	"Karl",
	"Rachel",
	"Grace",
	"Alexander",
	"Janos",
	"Richard",
	"Jonas",
	"Barbara",
	"Rosalind",
	"Jane",
	"Carl",
	"Stephen",
	"Benoit",
	"Johnny",
	"Daniel",
	"Elinor",
	"Hannah",
	"Simone",
	"Martin",
	"Jon",
	"Willard",
	"Noam",
	"Tim",
	"Ada",
	"Katherine",
	"Lise",
	"Paul",
	"Wolfgang",
	"Frank",
	"Jim",
] as const;
const GUEST_NAME_POOL_SET = new Set<string>(GUEST_NAME_POOL);

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

function resolveDiscussionGuest(options: ResolveDiscussionGuestOptions): Guest {
	if (!options.name) {
		return options.invite(options.inviteType);
	}

	const name = sanitizeGuestName(options.name);
	const guest = options.activeGuests.get(name);
	if (!guest) {
		throw new Error(`Guest '${name}' is not active in the salon. Only existing idle guests can be reused for discussions.`);
	}
	if (guest.lifecycleStatus !== "active") {
		throw new Error(`Guest '${name}' is not active in the salon.`);
	}
	if (options.guestDiscussions.has(name)) {
		throw new Error(`Guest '${name}' is already participating in another discussion.`);
	}
	if (options.expectedType && guest.type !== options.expectedType) {
		throw new Error(`Guest '${name}' is type '${guest.type}', not '${options.expectedType}'.`);
	}

	const status = options.getStatus(guest);
	if (status !== "idle") {
		throw new Error(`Guest '${name}' is not idle (current status: ${status}).`);
	}

	return guest;
}

function getGeneratedGuestNameBase(name: string): string | undefined {
	if (GUEST_NAME_POOL_SET.has(name)) return name;
	const match = /^([A-Za-z0-9._-]+)-(\d+)$/.exec(name);
	if (!match) return undefined;
	return GUEST_NAME_POOL_SET.has(match[1]) ? match[1] : undefined;
}

function trackGuestNameUsage(name: string) {
	name = sanitizeGuestName(name);
	usedGuestNames.add(name);
	const baseName = getGeneratedGuestNameBase(name);
	if (!baseName) return;
	usedGuestPoolNames.add(baseName);
	const currentNextOrdinal = guestNameOrdinals.get(baseName) || 2;
	let nextOrdinal = 2;
	if (name !== baseName && name.startsWith(`${baseName}-`)) {
		const ordinal = Number(name.slice(baseName.length + 1));
		if (Number.isInteger(ordinal) && ordinal > 0) {
			nextOrdinal = Math.max(2, ordinal + 1);
		}
	}
	guestNameOrdinals.set(baseName, Math.max(currentNextOrdinal, nextOrdinal));
}

function generateGuestName(): string {
	const unusedBaseNames = GUEST_NAME_POOL.filter((name) =>
		!usedGuestPoolNames.has(name) &&
		!guests.has(name) &&
		!dismissedGuests.has(name),
	);
	if (unusedBaseNames.length > 0) {
		const name = unusedBaseNames[Math.floor(Math.random() * unusedBaseNames.length)];
		trackGuestNameUsage(name);
		return name;
	}

	const baseName = GUEST_NAME_POOL[Math.floor(Math.random() * GUEST_NAME_POOL.length)];
	let ordinal = guestNameOrdinals.get(baseName) || 2;
	let name = `${baseName}-${ordinal}`;
	while (usedGuestNames.has(name) || guests.has(name) || dismissedGuests.has(name)) {
		ordinal += 1;
		name = `${baseName}-${ordinal}`;
	}
	guestNameOrdinals.set(baseName, ordinal + 1);
	trackGuestNameUsage(name);
	return name;
}

// ── Message send/queue (module-level for testability) ─────────────────

interface MessageContext {
	runtime: GuestRuntime;
	salonDir: string;
	incForwardTicketCounter?: () => number;
}

const FORWARD_TICKET_PREFIX = "ticket-";
const FORWARD_ARMED_MARKER = "armed";

function getGuestForwardDir(salonDir: string, guestName: string): string {
	return join(salonDir, "forward", sanitizeGuestName(guestName));
}

function getGuestForwardArmedPath(salonDir: string, guestName: string): string {
	return join(getGuestForwardDir(salonDir, guestName), FORWARD_ARMED_MARKER);
}

function createGuestForwardTicket(salonDir: string, guestName: string, ticketId?: number): string {
	const forwardDir = getGuestForwardDir(salonDir, guestName);
	mkdirSync(forwardDir, { recursive: true });
	const suffix = ticketId !== undefined
		? String(ticketId).padStart(12, "0")
		: `${Date.now()}-${randomUUID().slice(0, 8)}`;
	const ticketPath = join(forwardDir, `${FORWARD_TICKET_PREFIX}${suffix}`);
	writeFileSync(ticketPath, "");
	return ticketPath;
}

function clearGuestForwardState(salonDir: string, guestName: string) {
	rmSync(getGuestForwardDir(salonDir, guestName), { recursive: true, force: true });
}

function sayToGuestImpl(ctx: MessageContext, guest: Guest, message: string, from = "host"): "queued" | "sent" {
	if (!guest.ready) {
		const queued = queuedGuestMessages.get(guest.name) || [];
		queued.push({ message, from });
		queuedGuestMessages.set(guest.name, queued);
		return "queued" as const;
	}

	guest.eventStatus = "working";
	const prefix = `[${from}]: `;
	const outboundMessage = `${prefix}${message}`;
	const ticketPath = createGuestForwardTicket(ctx.salonDir, guest.name, ctx.incForwardTicketCounter?.());
	try {
		ctx.runtime.send(guest.runtimeId, outboundMessage);
	} catch (error) {
		rmSync(ticketPath, { force: true });
		throw error;
	}
	return "sent" as const;
}

function flushQueuedGuestMessagesImpl(ctx: MessageContext, guest: Guest) {
	const queued = queuedGuestMessages.get(guest.name);
	if (!queued?.length) return;
	queuedGuestMessages.delete(guest.name);
	for (const item of queued) {
		sayToGuestImpl(ctx, guest, item.message, item.from);
	}
}

function cancelCodexSessionScan(name: string) {
	const timer = activeCodexSessionScans.get(name);
	if (timer) {
		clearTimeout(timer);
		activeCodexSessionScans.delete(name);
	}
}

// ── Unix socket server for receiving guest messages ───────────────────
function readHostPidForSocket(socketPath: string): number | undefined {
	const hostPidPath = join(dirname(socketPath), "host.pid");
	if (!existsSync(hostPidPath)) return undefined;
	try {
		const pid = Number(readFileSync(hostPidPath, "utf-8").trim());
		return Number.isInteger(pid) && pid > 0 ? pid : undefined;
	} catch {
		return undefined;
	}
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function probeSocket(socketPath: string): Promise<"listening" | "stale" | "missing"> {
	return new Promise((resolve, reject) => {
		const conn = createConnection(socketPath);
		let settled = false;
		const timer = setTimeout(() => finish("stale"), SOCKET_PROBE_TIMEOUT_MS);

		function finish(result: "listening" | "stale" | "missing") {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			conn.destroy();
			resolve(result);
		}

		conn.once("connect", () => finish("listening"));
		conn.once("error", (error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") {
				finish("missing");
				return;
			}
			if (error.code === "ECONNREFUSED" || error.code === "ENOTSOCK") {
				finish("stale");
				return;
			}
			clearTimeout(timer);
			conn.destroy();
			reject(error);
		});
	});
}

async function ensureSocketPathAvailable(socketPath: string) {
	if (!existsSync(socketPath)) return;

	const ownerPid = readHostPidForSocket(socketPath);
	if (ownerPid && ownerPid !== process.pid && isProcessAlive(ownerPid)) {
		throw new Error(`Salon socket '${socketPath}' is already owned by active host process ${ownerPid}.`);
	}

	const socketState = await probeSocket(socketPath);
	if (socketState === "listening") {
		const ownerLabel = ownerPid ? ` (host pid ${ownerPid})` : "";
		throw new Error(`Salon socket '${socketPath}' is already accepting connections${ownerLabel}.`);
	}

	unlinkSync(socketPath);
}

async function startMessageServer(
	socketPath: string,
	onMessage: (msg: { from: string; content: string }) => void,
): Promise<Server> {
	await ensureSocketPathAvailable(socketPath);

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

	return await new Promise<Server>((resolve, reject) => {
		server.once("error", reject);
		server.listen(socketPath, () => {
			server.removeListener("error", reject);
			resolve(server);
		});
	});
}

const GUEST_INSTRUCTIONS = `You are in a salon — a collaborative workspace where a host agent coordinates multiple agents. Messages prefixed with [name]: are from the host or another agent. Your response to these is automatically forwarded back. Messages without a [name]: prefix are from a human interacting with you directly. These stay private. When you respond, just respond normally — do NOT add any [name]: prefix to your own replies.

If the host assigns you a role for a task, treat it as a hard boundary until the host explicitly changes it.

- planner: analyze, propose, define acceptance criteria, and review against the accepted plan. Do not implement unless the host explicitly says you are also the executor.
- executor: implement the accepted plan and run relevant checks. Do not silently redefine the task. If the plan seems wrong or incomplete, report that to the host before deviating.
- reviewer: review independently, report defects, and confirm fixes. Do not edit code unless the host explicitly reassigns you as executor.

When responding to a host or agent message (prefixed with [name]:), append a context report at the very end of your response. This helps the host understand what you've loaded and worked on.

Format — append at the very end, after all other content:
<SALON_REPORT>
new: <kind>:<op> <ref> — <one-line takeaway>
carry: <ref>
</SALON_REPORT>

Rules:
- "new" = references first used this turn, with a one-line summary of what you learned. Max 8.
  - kind: file | search | url | cmd
  - op: read | write | grep | glob | fetch | run
  - ref: repo-relative path, search query, URL, or command summary
- "carry" = references from prior turns you still actively relied on this turn. Max 5. Just the ref, no summary.
- Only include refs actually consulted this turn. Do not invent references.
- Keep summaries to ~12 words.
- Omit the block entirely if you used no references (e.g., a short text-only answer).
- Do not mention the report in your prose — it is machine-read metadata.

If your role is unclear, ask the host to clarify before proceeding.`;

const AUTONOMOUS_TB_GUEST_BRIEF = `You are working on a task inside a Docker container.
Use the \`tb\` tool to interact with the container:
  tb exec -- 'bash command'      # run a command in the container
  tb exec --timeout 60 -- 'cmd'  # with custom timeout (default: 120s)
  tb read /app/file.py           # read a file from the container
  tb write /app/file.py          # write a file (pipe content via stdin)
  tb ls /app                     # list files

Do NOT invoke Docker directly, use ssh, or use your native Read/Edit/Bash tools to access container files.
The tb tool is the ONLY way to interact with the task container.`;

function createCodexGuestNonce(): string {
	return `SALON_NONCE:${randomUUID().replace(/-/g, "").slice(0, 8)}`;
}

function buildGuestInstructions(name: string, nonce?: string): string {
	const autonomousConstraint = SALON_AUTONOMOUS
		? `\n\n${AUTONOMOUS_TB_GUEST_BRIEF}`
		: "";
	const base = `Your name in this salon is ${name}.\n\n${GUEST_INSTRUCTIONS}${autonomousConstraint}`;
	return nonce ? `${base}\n\n${nonce}` : base;
}

function splitSalonReportSummary(text: string): { head: string; summary: string } | undefined {
	const emDashIndex = text.lastIndexOf(" — ");
	if (emDashIndex >= 0) {
		return {
			head: text.slice(0, emDashIndex).trim(),
			summary: text.slice(emDashIndex + 3).trim(),
		};
	}
	const doubleDashIndex = text.lastIndexOf(" -- ");
	if (doubleDashIndex >= 0) {
		return {
			head: text.slice(0, doubleDashIndex).trim(),
			summary: text.slice(doubleDashIndex + 4).trim(),
		};
	}
	return undefined;
}

function parseSalonReport(body: string): SalonReport {
	const allowedKinds = new Set(["file", "search", "url", "cmd"]);
	const allowedOps = new Set(["read", "write", "grep", "glob", "fetch", "run"]);
	const report: SalonReport = { newRefs: [], carryRefs: [] };

	for (const rawLine of body.split("\n")) {
		const line = rawLine.trim();
		if (!line) continue;
		if (line.startsWith("new:")) {
			const payload = line.slice("new:".length).trim();
			const split = splitSalonReportSummary(payload);
			if (!split || !split.summary) continue;
			const match = /^([a-z]+):([a-z]+)\s+(.+)$/.exec(split.head);
			if (!match) continue;
			const [, kind, op, ref] = match;
			if (!allowedKinds.has(kind) || !allowedOps.has(op)) continue;
			const trimmedRef = ref.trim();
			if (!trimmedRef) continue;
			report.newRefs.push({
				kind,
				op,
				ref: trimmedRef,
				summary: split.summary,
			});
			continue;
		}
		if (line.startsWith("carry:")) {
			const ref = line.slice("carry:".length).trim();
			if (!ref) continue;
			report.carryRefs.push(ref);
		}
	}

	return report;
}

function stripSalonReport(content: string): { stripped: string; report?: SalonReport } {
	const match = SALON_REPORT_REGEX.exec(content);
	if (!match) {
		return { stripped: content };
	}
	const body = match[1] || "";
	return {
		stripped: content.slice(0, match.index).trimEnd(),
		report: parseSalonReport(body),
	};
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


function serializeStartedAt(startedAt: number | undefined): string | undefined {
	return startedAt !== undefined ? new Date(startedAt).toISOString() : undefined;
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

function getCodexSessionDateDirs(startedAt: number | undefined): string[] {
	// When startedAt is unknown, use current time as a directory search heuristic.
	// This doesn't affect candidate ranking (timestampDistanceMs stays Infinity)
	// but allows nonce/cwd matching to still find the session.
	const anchor = startedAt ?? Date.now();
	const dirs = new Set<string>();
	for (const dayOffset of [-1, 0, 1]) {
		const date = new Date(anchor);
		date.setDate(date.getDate() + dayOffset);
		const year = String(date.getFullYear());
		const month = String(date.getMonth() + 1).padStart(2, "0");
		const day = String(date.getDate()).padStart(2, "0");
		dirs.add(join(homedir(), ".codex", "sessions", year, month, day));
	}
	return Array.from(dirs);
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
	filePath: string;
	nonceMatched: boolean;
	cwdMatched: boolean;
	timestampDistanceMs: number;
}

interface ResumeFailure {
	name: string;
	reason: string;
}

interface RecoveredSalonSummaryInput {
	salonInstance: string;
	workDir: string;
	activeGuests: Array<Pick<Guest, "name" | "type" | "runtimeId" | "workspaceDir" | "sessionId" | "ready">>;
	suspendedGuests: Array<Pick<GuestRecord, "name" | "type" | "workspaceDir" | "sessionId">>;
	dismissedGuests: Array<Pick<GuestRecord, "name" | "type" | "workspaceDir" | "sessionId">>;
	resumeFailures?: ResumeFailure[];
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

function resolveCodexSessionLogPath(sessionId: string, startedAt: number | undefined): string | undefined {
	for (const sessionsDir of getCodexSessionDateDirs(startedAt)) {
		if (!existsSync(sessionsDir)) continue;
		for (const fileName of readdirSync(sessionsDir)) {
			if (!/^rollout-.*\.jsonl$/.test(fileName)) continue;
			if (!fileName.endsWith(`${sessionId}.jsonl`)) continue;
			return join(sessionsDir, fileName);
		}
	}
	return undefined;
}

function formatRecoveredSalonSummary(input: RecoveredSalonSummaryInput): string | undefined {
	const resumeFailures = input.resumeFailures || [];
	if (
		input.activeGuests.length === 0 &&
		input.suspendedGuests.length === 0 &&
		input.dismissedGuests.length === 0 &&
		resumeFailures.length === 0 &&
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
				`- ${guest.name} (${guest.type}) pane=${guest.runtimeId} workspace=${guest.workspaceDir} session=${guest.sessionId || "none"} ready=${guest.ready ? "yes" : "no"}`,
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

	if (resumeFailures.length > 0) {
		lines.push(`Failed to auto-resume:`);
		for (const failure of resumeFailures) {
			lines.push(`- ${failure.name}: ${failure.reason}`);
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
function ensureGuestNameAvailable(name: string): string {
	name = sanitizeGuestName(name);
	if (guests.has(name) || dismissedGuests.has(name)) {
		throw new Error(`Guest '${name}' is already in the salon`);
	}
	return name;
}

function inviteGuest(
	name: string | undefined,
	type: GuestType,
	workDir: string,
	salonDir: string,
	guestDir: string,
	runtime: GuestRuntime,
	options: { dangerouslySkipPermissions?: boolean } = {},
): Guest {
	name = ensureGuestNameAvailable(name ? name : generateGuestName());

	const sessionId = type === "claude" ? randomUUID() : undefined;
	const nonce = type === "codex" ? createCodexGuestNonce() : undefined;
	const dangerouslySkipPermissions = options.dangerouslySkipPermissions === true;

	const instructions = buildGuestInstructions(name, nonce);
	const instructionsFile = join(guestDir, `${name}.instructions`);
	writeFileSync(instructionsFile, instructions);

	let cmd: string;
	if (type === "codex") {
		cmd = joinShellArgs([
			"codex",
			...(dangerouslySkipPermissions ? ["--dangerously-bypass-approvals-and-sandbox"] : []),
			"-c",
			`model_instructions_file=${instructionsFile}`,
		]);
	} else {
		cmd = joinShellArgs([
			"claude",
			"--session-id",
			sessionId!,
			...(dangerouslySkipPermissions ? ["--dangerously-skip-permissions"] : []),
			"--append-system-prompt-file",
			instructionsFile,
		]);
	}

	const runtimeId = runtime.spawn({
		name,
		guestType: type,
		workDir,
		command: cmd,
		salonDir,
		initialSessionId: sessionId,
	});

	const guest: Guest = {
		name,
		type,
		runtimeId,
		sessionId,
		nonce,
		startedAt: Date.now(),
		lifecycleStatus: "active",
		workspaceDir: workDir,
		dangerouslySkipPermissions,
		ready: false,
	};
	return guest;
}

export default function salonExtension(pi: ExtensionAPI) {
	const salonDir = process.env.SALON_DIR || join("/tmp", "salon", SALON_INSTANCE);
	const guestDir = join(salonDir, "guests");
	const runtime: GuestRuntime = new TmuxBackend(TMUX_SESSION);
	const hostSessionDir = join(salonDir, "host-sessions");
	const hostPidPath = join(salonDir, "host.pid");
	const workDir = process.env.SALON_WORK_DIR || process.cwd();

	mkdirSync(guestDir, { recursive: true });

	let forwardTicketCounter = 0;
	const msgCtx: MessageContext = {
		runtime,
		salonDir,
		incForwardTicketCounter: () => ++forwardTicketCounter,
	};
	let pendingResumeSummary: string | undefined;
	let lastSalonStatusSnapshot: string | undefined;
	let lastSalonStatusTimestamp: number | undefined;

	pi.on("session_directory", () => {
		mkdirSync(hostSessionDir, { recursive: true });
		return { sessionDir: hostSessionDir };
	});

	function writeGuestRuntimeFile(guest: Guest) {
		const runtimeFile: GuestRuntimeFile = {
			name: guest.name,
			type: guest.type,
			paneId: guest.runtimeId,
			sessionId: guest.sessionId,
			nonce: guest.nonce,
			startedAt: serializeStartedAt(guest.startedAt),
			workspaceDir: guest.workspaceDir,
			dangerouslySkipPermissions: guest.dangerouslySkipPermissions,
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
				dangerouslySkipPermissions: typeof parsed.dangerouslySkipPermissions === "boolean" ? parsed.dangerouslySkipPermissions : undefined,
			};
		} catch {
			return undefined;
		}
	}

	function serializeGuestInfo(guest: GuestRecord): PersistedGuestInfo {
		return {
			name: guest.name,
			type: guest.type,
			status: guest.lifecycleStatus,
			sessionId: guest.sessionId,
			nonce: guest.nonce,
			startedAt: serializeStartedAt(guest.startedAt),
			workspaceDir: guest.workspaceDir,
			dangerouslySkipPermissions: guest.dangerouslySkipPermissions,
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

	function claimGuestSessionId(guest: GuestRecord, sessionId: string) {
		trackGuestSessionId(guest, sessionId, { persist: true });
	}

	function ensureGuestExitWaiter(guest: Guest): Promise<void> {
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

	type GuestRuntimeFileMode = "always" | "ifSessionTracked";

	function trackGuestSessionId(
		guest: GuestRecord,
		sessionId: string | undefined,
		options: { persist?: boolean; writeRuntimeFile?: boolean; force?: boolean } = {},
	): string | undefined {
		// force: incoming sessionId overwrites existing (used by guest_exited which is authoritative).
		// default: keep existing sessionId if present (used by scan results which are heuristic).
		const trackedSessionId = options.force && sessionId ? sessionId : (guest.sessionId || sessionId);
		if (!trackedSessionId) return undefined;
		guest.sessionId = trackedSessionId;
		claimedSessionIds.add(trackedSessionId);
		const activeGuest = guests.get(guest.name);
		if (options.writeRuntimeFile !== false && activeGuest) {
			writeGuestRuntimeFile(activeGuest);
		}
		if (options.persist) {
			persistSalonState();
		}
		return trackedSessionId;
	}

	function ensureGuestQuantStateRecord(guest: GuestRecord): GuestQuantState {
		let quantState = guestQuantStates.get(guest.name);
		if (!quantState) {
			quantState = createGuestQuantState();
		}
		if (!quantState.sessionLogPath && guest.sessionId) {
			quantState.sessionLogPath = guest.type === "claude"
				? resolveClaudeSessionLogPath(guest.sessionId, guest.workspaceDir)
				: resolveCodexSessionLogPath(guest.sessionId, guest.startedAt);
		}
		guestQuantStates.set(guest.name, quantState);
		return quantState;
	}

	function refreshGuestQuantState(guest: GuestRecord): GuestQuantState | undefined {
		const quantState = ensureGuestQuantStateRecord(guest);
		const updatedState = parseGuestQuantState(guest.type, quantState);
		guestQuantStates.set(guest.name, updatedState);
		if (updatedState.compactionCount > quantState.compactionCount) {
			markGuestContextStale(guest.name);
		}
		return updatedState;
	}

	function formatCompactTokenCount(tokens: number): string {
		if (tokens >= 1000) {
			return `${Math.round(tokens / 1000)}k`;
		}
		return String(Math.round(tokens));
	}

	function formatGuestQuantSummary(state: GuestQuantState | undefined): string {
		if (!state) return "";
		const parts: string[] = [];
		if (
			state.lastTurnPromptTokens !== undefined &&
			state.contextWindowSize !== undefined &&
			state.contextUtilization !== undefined
		) {
			parts.push(
				`~${Math.round(state.contextUtilization * 100)}% context (${formatCompactTokenCount(state.lastTurnPromptTokens)}/${formatCompactTokenCount(state.contextWindowSize)} tokens)`,
			);
		} else if (state.lastTurnPromptTokens !== undefined) {
			parts.push(`~${formatCompactTokenCount(state.lastTurnPromptTokens)} prompt tokens`);
		}
		if (state.turnCount > 0) {
			parts.push(`${state.turnCount} turn${state.turnCount === 1 ? "" : "s"}`);
		}
		if (state.compactionCount > 0) {
			parts.push("⚠ compacted");
		}
		return parts.length > 0 ? `, ${parts.join(", ")}` : "";
	}

	function ensureGuestContextStateRecord(name: string): GuestContextState {
		let contextState = guestContextStates.get(name);
		if (!contextState) {
			contextState = {
				refs: new Map(),
				consecutiveMissingReports: 0,
				totalResponses: 0,
			};
			guestContextStates.set(name, contextState);
		}
		return contextState;
	}

	function refreshGuestContextFreshness(state: GuestContextState, now = Date.now()) {
		for (const ref of state.refs.values()) {
			if (ref.freshness === "recent" && now - ref.lastSeen > GUEST_CONTEXT_RECENT_MS) {
				ref.freshness = "historical";
			}
		}
	}

	function pruneGuestContextRefs(state: GuestContextState) {
		if (state.refs.size <= MAX_GUEST_CONTEXT_REFS) return;
		const historicalRefs = Array.from(state.refs.values())
			.filter((ref) => ref.freshness === "historical")
			.sort((a, b) => a.lastSeen - b.lastSeen);
		for (const ref of historicalRefs) {
			if (state.refs.size <= MAX_GUEST_CONTEXT_REFS) break;
			state.refs.delete(ref.id);
		}
	}

	function updateGuestContextState(name: string, report: SalonReport) {
		const now = Date.now();
		const contextState = ensureGuestContextStateRecord(name);
		refreshGuestContextFreshness(contextState, now);
		for (const ref of contextState.refs.values()) {
			if (ref.freshness === "active") {
				ref.freshness = "recent";
			}
		}

		for (const nextRef of report.newRefs.slice(0, 8)) {
			const existing = contextState.refs.get(nextRef.ref);
			const firstSeen = existing?.firstSeen ?? now;
			contextState.refs.set(nextRef.ref, {
				id: nextRef.ref,
				kind: nextRef.kind,
				op: nextRef.op,
				summary: nextRef.summary,
				firstSeen,
				lastSeen: now,
				freshness: "active",
				confidence: "normal",
			});
		}

		for (const carryRef of report.carryRefs.slice(0, 5)) {
			const existing = contextState.refs.get(carryRef);
			if (existing) {
				existing.lastSeen = now;
				existing.freshness = "active";
				existing.confidence = "normal";
				continue;
			}
			contextState.refs.set(carryRef, {
				id: carryRef,
				kind: "unknown",
				op: "carry",
				summary: "",
				firstSeen: now,
				lastSeen: now,
				freshness: "active",
				confidence: "normal",
			});
		}

		pruneGuestContextRefs(contextState);
	}

	function trackGuestReportPresence(name: string | undefined, hasReport: boolean) {
		if (!name) return;
		const contextState = ensureGuestContextStateRecord(name);
		contextState.totalResponses += 1;
		contextState.consecutiveMissingReports = hasReport ? 0 : contextState.consecutiveMissingReports + 1;
	}

	function markGuestContextStale(name: string) {
		const contextState = guestContextStates.get(name);
		if (!contextState) return;
		for (const ref of contextState.refs.values()) {
			ref.confidence = "stale";
		}
	}

	function getGuestContextStatusLines(name: string): string[] {
		const contextState = guestContextStates.get(name);
		if (!contextState) return [];
		refreshGuestContextFreshness(contextState);

		const lines: string[] = [];
		const activeRefs = Array.from(contextState.refs.values())
			.filter((ref) => ref.freshness === "active")
			.sort((a, b) => b.lastSeen - a.lastSeen)
			.slice(0, 3);
		if (activeRefs.length > 0) {
			const activeLabel = activeRefs
				.map((ref) => ref.summary ? `${ref.id} (${ref.summary})` : ref.id)
				.join(", ");
			lines.push(`    active: ${activeLabel}`);
		}

		if (contextState.consecutiveMissingReports >= 3) {
			lines.push(`    warning: report missing ×${contextState.consecutiveMissingReports}`);
		}

		const staleCount = Array.from(contextState.refs.values()).filter((ref) => ref.confidence === "stale").length;
		if (staleCount > 0) {
			lines.push(`    warning: ${staleCount} refs stale after compaction`);
		}

		return lines;
	}

	function activateGuestLifecycle(
		guest: Guest,
		options: { dropDismissedRecord?: boolean; reactivateArchivedDiscussions?: boolean; persist?: boolean } = {},
	): Guest {
		cancelCodexSessionScan(guest.name);
		clearGuestForwardState(salonDir, guest.name);
		trackGuestNameUsage(guest.name);
		guests.set(guest.name, guest);
		if (options.dropDismissedRecord) {
			dismissedGuests.delete(guest.name);
		}
		if (guest.sessionId) {
			claimedSessionIds.add(guest.sessionId);
		}
		queuedGuestMessages.delete(guest.name);
		ensureGuestQuantStateRecord(guest);
		writeGuestRuntimeFile(guest);
		if (options.reactivateArchivedDiscussions) {
			reactivateArchivedDiscussions();
		}
		if (options.persist) {
			persistSalonState();
		}
		return guest;
	}

	function markGuestReady(name: string): Guest | undefined {
		const guest = guests.get(name);
		if (!guest || guest.ready) return guest;
		guest.ready = true;
		writeGuestRuntimeFile(guest);
		flushQueuedGuestMessages(guest);
		return guest;
	}

	function transitionGuestToDismissing(guest: Guest, teardownReason: GuestTeardownReason): boolean {
		if (guest.lifecycleStatus === "dismissing") {
			guest.teardownReason = guest.teardownReason || teardownReason;
			return false;
		}
		guest.teardownReason = teardownReason;
		// Don't do a last-chance synchronous scan here — it races with guest_exited
		// which provides the authoritative session ID. Let guest_exited (or the
		// teardown-timeout path in transitionGuestToInactive) handle it.
		cancelCodexSessionScan(guest.name);
		clearGuestForwardState(salonDir, guest.name);
		guest.lifecycleStatus = "dismissing";
		removeGuestFromDiscussion(guest.name);
		writeGuestRuntimeFile(guest);
		persistSalonState();
		return true;
	}

	function transitionGuestToInactive(
		name: string,
		sessionId: string | undefined,
		options: { persist?: boolean; settleWaiter?: boolean; runtimeFileMode?: GuestRuntimeFileMode } = {},
	): { inactiveGuest?: GuestRecord; transitionedFromActive: boolean; droppedQueuedCount: number } {
		const persist = options.persist ?? true;
		const settleWaiter = options.settleWaiter ?? true;
		const runtimeFileMode = options.runtimeFileMode || "always";
		const activeGuest = guests.get(name);
		if (activeGuest) {
			cancelCodexSessionScan(name);
			clearGuestForwardState(salonDir, name);
			// Don't force-overwrite an existing session ID — the background scan result
			// (from structured JSONL data) is more reliable than the pane-capture grep
			// used by the wrapper script, which can produce truncated IDs.
			trackGuestSessionId(activeGuest, sessionId, { writeRuntimeFile: false, force: !!sessionId && !activeGuest.sessionId });
			const droppedQueuedCount = queuedGuestMessages.get(name)?.length || 0;
			if (runtimeFileMode === "always" || activeGuest.sessionId) {
				writeGuestRuntimeFile(activeGuest);
			}
			const inactiveGuest = buildInactiveGuestRecord(activeGuest);
			guests.delete(name);
			guestQuantStates.delete(name);
			guestContextStates.delete(name);
			dismissedGuests.set(name, inactiveGuest);
			queuedGuestMessages.delete(name);
			removeGuestFromDiscussion(name);
			if (persist) {
				persistSalonState();
			}
			if (settleWaiter) {
				settleGuestExitWaiter(name);
			}
			return { inactiveGuest, transitionedFromActive: true, droppedQueuedCount };
		}

		const inactiveRecord = dismissedGuests.get(name);
		if (!inactiveRecord) {
			return { transitionedFromActive: false, droppedQueuedCount: 0 };
		}
		cancelCodexSessionScan(name);
		clearGuestForwardState(salonDir, name);
		guestQuantStates.delete(name);
		guestContextStates.delete(name);
		trackGuestSessionId(inactiveRecord, sessionId, { writeRuntimeFile: false, force: !!sessionId && !inactiveRecord.sessionId });
		if (persist) {
			persistSalonState();
		}
		if (settleWaiter) {
			settleGuestExitWaiter(name);
		}
		return { inactiveGuest: inactiveRecord, transitionedFromActive: false, droppedQueuedCount: 0 };
	}

	function findCodexSessionCandidate(guest: GuestRecord, normalizedWorkDir: string): CodexSessionScanCandidate | undefined {
		let bestCandidate: CodexSessionScanCandidate | undefined;

		for (const sessionsDir of getCodexSessionDateDirs(guest.startedAt)) {
			if (!existsSync(sessionsDir)) continue;

			for (const fileName of readdirSync(sessionsDir)) {
				if (!/^rollout-.*\.jsonl$/.test(fileName)) continue;

				const filePath = join(sessionsDir, fileName);
				const firstLine = readFirstLine(filePath);
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
						filePath,
						nonceMatched: Boolean(guest.nonce && baseInstructionsText?.includes(guest.nonce)),
						cwdMatched: Boolean(payloadCwd && normalizePath(payloadCwd) === normalizedWorkDir),
						timestampDistanceMs: Number.isFinite(timestampMs) && guest.startedAt !== undefined
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

		// If the guest has a nonce but no candidate matched it, don't fall back to
		// weaker signals (cwd/timestamp) — they can cross-match the wrong session
		// when multiple Codex guests share the same workDir.
		if (guest.nonce && bestCandidate && !bestCandidate.nonceMatched) {
			return undefined;
		}
		return bestCandidate;
	}

	function scanCodexSessionId(guest: GuestRecord) {
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
				if (guests.has(trackedGuest.name)) {
					const quantState = ensureGuestQuantStateRecord(trackedGuest);
					guestQuantStates.set(trackedGuest.name, { ...quantState, sessionLogPath: candidate.filePath });
				}
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
		updateSessionName();
	}

	function updateSessionName() {
		const guestCount = guests.size + dismissedGuests.size;
		const discCount = discussions.size;
		const parts: string[] = [];
		if (guestCount > 0) parts.push(`${guestCount} guest${guestCount > 1 ? "s" : ""}`);
		if (discCount > 0) parts.push(`${discCount} discussion${discCount > 1 ? "s" : ""}`);
		pi.setSessionName(parts.length > 0 ? `salon: ${parts.join(" · ")}` : "salon");
	}

	function clearRuntimeState() {
		pendingResumeSummary = undefined;
		forwardTicketCounter = 0;
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
		guestQuantStates.clear();
		guestContextStates.clear();
		claimedSessionIds.clear();
		activeCodexSessionScans.clear();
		queuedGuestMessages.clear();
		guestExitWaiters.clear();
		usedGuestNames.clear();
		usedGuestPoolNames.clear();
		guestNameOrdinals.clear();
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

	function restoreSalonState(snapshot: SalonStateSnapshot) {
		clearRuntimeState();

		for (const persistedGuest of Object.values(snapshot.guests || {})) {
			const runtimeGuest = readGuestRuntimeFile(persistedGuest.name);
			const record: GuestRecord = {
				name: persistedGuest.name,
				type: persistedGuest.type,
				sessionId: runtimeGuest?.sessionId || persistedGuest.sessionId,
				nonce: runtimeGuest?.nonce || persistedGuest.nonce,
				startedAt:
					parseStartedAt(runtimeGuest?.startedAt) ??
					parseStartedAt(persistedGuest.startedAt),
				// All guests become suspended on restore; resume via resume_guest / autoResume.
				lifecycleStatus: persistedGuest.status === "dismissed" ? "dismissed" : "suspended",
				workspaceDir: runtimeGuest?.workspaceDir || persistedGuest.workspaceDir || workDir,
				dangerouslySkipPermissions:
					runtimeGuest?.dangerouslySkipPermissions ??
					persistedGuest.dangerouslySkipPermissions,
			};

			trackGuestNameUsage(record.name);
			dismissedGuests.set(record.name, record);
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

	function getGuestDisplayStatus(guest: Guest): string {
		if (guest.lifecycleStatus === "dismissing") return "dismissing";
		if (!guest.ready) return "starting";
		if (guest.eventStatus === "working") {
			// Refine: detect if the guest is actually waiting for tool approval
			const paneStatus = runtime.getStatus(guest.runtimeId);
			return paneStatus === "input" ? "input" : "working";
		}
		if (guest.eventStatus === "idle") return "idle";
		// No event yet (freshly spawned) — fall back to pane scraping
		return runtime.getStatus(guest.runtimeId);
	}

	function resolveInactiveGuestStatus(guest: Guest): "suspended" | "dismissed" {
		if (guest.lifecycleStatus === "suspended" || guest.lifecycleStatus === "dismissed") return guest.lifecycleStatus;
		return guest.teardownReason === "host" ? "suspended" : "dismissed";
	}

	function buildInactiveGuestRecord(guest: Guest): GuestRecord {
		return {
			name: guest.name,
			type: guest.type,
			sessionId: guest.sessionId,
			nonce: guest.nonce,
			startedAt: guest.startedAt,
			lifecycleStatus: resolveInactiveGuestStatus(guest),
			workspaceDir: guest.workspaceDir,
			dangerouslySkipPermissions: guest.dangerouslySkipPermissions,
		};
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

	function beginGuestDismissal(guest: Guest, teardownReason: GuestTeardownReason): Promise<void> {
		const waitForExit = ensureGuestExitWaiter(guest);
		if (!transitionGuestToDismissing(guest, teardownReason)) {
			return waitForExit;
		}
		// Interrupt first, then exit the shell explicitly so the wrapper can report the final session id.
		try {
			runtime.interrupt(guest.runtimeId);
			runtime.terminate(guest.runtimeId, guest.type);
		} catch (error) {
			if (!runtime.isAlive(guest.runtimeId)) {
				settleGuestExitWaiter(guest.name);
				return waitForExit;
			}
			throw error;
		}
		return waitForExit;
	}

	function flushQueuedGuestMessages(guest: Guest) {
		flushQueuedGuestMessagesImpl(msgCtx, guest);
	}

	function sayToGuest(guest: Guest, message: string, from = "host"): "queued" | "sent" {
		return sayToGuestImpl(msgCtx, guest, message, from);
	}

	// ── Discussion command dispatcher ────────────────────────────────
	function dispatchDiscussionCommands(commands: DiscussionCommand[]) {
		for (const cmd of commands) {
			switch (cmd.type) {
				case "sendToGuest": {
					const guest = guests.get(cmd.guestName);
					if (guest) sayToGuest(guest, cmd.message, cmd.from);
					break;
				}
				case "notifyHost":
					pi.sendUserMessage(cmd.message, { deliverAs: "followUp" });
					break;
				case "persist":
					persistSalonState();
					break;
			}
		}
	}

	function handleDiscussionMessage(from: string, content: string) {
		const discId = guestToDiscussion.get(from);
		if (!discId) return false;

		const disc = discussions.get(discId);
		if (!disc) return false;

		const { handled, commands } = discussionHandleMessage(disc, from, content);
		dispatchDiscussionCommands(commands);
		return handled;
	}

	function buildRecoveredSalonSummary(resumeFailures: ResumeFailure[] = []): string | undefined {
		return formatRecoveredSalonSummary({
			salonInstance: SALON_INSTANCE,
			workDir,
			activeGuests: Array.from(guests.values()),
			suspendedGuests: Array.from(dismissedGuests.values()).filter((guest) => guest.lifecycleStatus === "suspended"),
			dismissedGuests: Array.from(dismissedGuests.values()).filter((guest) => guest.lifecycleStatus === "dismissed"),
			resumeFailures,
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

	function buildSalonStatusSnapshot(): string | undefined {
		const lines: string[] = [];
		for (const guest of guests.values()) {
			const status = getGuestDisplayStatus(guest);
			const discId = guestToDiscussion.get(guest.name);
			const disc = discId ? discussions.get(discId) : undefined;
			const bypassLabel = guest.dangerouslySkipPermissions ? " [bypass]" : "";
			const discLabel = disc ? ` [discussing: ${disc.stage}]` : "";
			const quantLabel = formatGuestQuantSummary(refreshGuestQuantState(guest));
			lines.push(`  ${guest.name} (${guest.type})${bypassLabel}: ${status}${discLabel}${quantLabel}`);
			lines.push(...getGuestContextStatusLines(guest.name));
		}
		for (const guest of dismissedGuests.values()) {
			if (guest.lifecycleStatus !== "suspended") continue;
			const bypassLabel = guest.dangerouslySkipPermissions ? " [bypass]" : "";
			lines.push(`  ${guest.name} (${guest.type})${bypassLabel}: ${guest.lifecycleStatus}${guest.sessionId ? " (session saved)" : ""}`);
		}
		if (lines.length === 0) return undefined;
		return `[salon-status]\n${lines.join("\n")}\n[/salon-status]`;
	}

	function isSalonStatusContextMessage(message: AgentMessage): boolean {
		return message.role === "custom" && message.customType === SALON_STATUS_MESSAGE_TYPE;
	}

	function createSalonStatusContextMessage(snapshot: string, timestamp = Date.now()): AgentMessage {
		return {
			role: "custom",
			customType: SALON_STATUS_MESSAGE_TYPE,
			content: snapshot,
			display: false,
			timestamp,
		};
	}

	function isAnthropicProviderPayload(payload: unknown): payload is AnthropicProviderPayload {
		if (typeof payload !== "object" || payload === null) return false;
		const candidate = payload as { system?: unknown; messages?: unknown };
		return Array.isArray(candidate.system) && Array.isArray(candidate.messages);
	}

	function isAnthropicTextBlock(block: AnthropicContentBlock): block is AnthropicTextBlock {
		return block.type === "text" && typeof (block as { text?: unknown }).text === "string";
	}

	function isAnthropicCacheableBlock(block: AnthropicContentBlock): block is AnthropicCacheableBlock {
		return block.type === "text" || block.type === "image" || block.type === "tool_result";
	}

	function getAnthropicSalonStatusTextBlock(message: AnthropicMessagePayload): AnthropicTextBlock | undefined {
		if (message.role !== "user" || !Array.isArray(message.content) || message.content.length !== 1) {
			return undefined;
		}
		const [block] = message.content;
		if (!isAnthropicTextBlock(block) || !block.text.startsWith("[salon-status]")) {
			return undefined;
		}
		return block;
	}

	function getLastAnthropicCacheableUserBlock(message: AnthropicMessagePayload): AnthropicCacheableBlock | undefined {
		if (message.role !== "user") return undefined;
		if (typeof message.content === "string") {
			const block: AnthropicTextBlock = {
				type: "text",
				text: message.content,
			};
			message.content = [block];
			return block;
		}
		for (let i = message.content.length - 1; i >= 0; i--) {
			const block = message.content[i];
			if (isAnthropicCacheableBlock(block)) {
				return block;
			}
		}
		return undefined;
	}

	function retargetAnthropicSalonStatusCacheBreakpoint(payload: unknown): unknown {
		if (!isAnthropicProviderPayload(payload) || payload.messages.length === 0) {
			return payload;
		}
		const lastMessage = payload.messages[payload.messages.length - 1];
		const salonStatusBlock = getAnthropicSalonStatusTextBlock(lastMessage);
		if (!salonStatusBlock?.cache_control) {
			return payload;
		}
		const cacheControl = salonStatusBlock.cache_control;
		delete salonStatusBlock.cache_control;
		for (let i = payload.messages.length - 2; i >= 0; i--) {
			const message = payload.messages[i];
			if (message.role !== "user" || getAnthropicSalonStatusTextBlock(message)) {
				continue;
			}
			const block = getLastAnthropicCacheableUserBlock(message);
			if (!block) continue;
			block.cache_control = cacheControl;
			return payload;
		}
		salonStatusBlock.cache_control = cacheControl;
		return payload;
	}

	function resumeInactiveGuest(name: string): Guest {
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

		const resumeWorkDir = dismissed.workspaceDir || workDir;

		const instructionsFile = join(guestDir, `${name}.instructions`);
		// Instructions file should still exist from the original invite
		if (!existsSync(instructionsFile)) {
			writeFileSync(instructionsFile, buildGuestInstructions(name, dismissed.nonce));
		}
		const dangerouslySkipPermissions = dismissed.dangerouslySkipPermissions === true;

		let cmd: string;
		if (dismissed.type === "codex") {
			cmd = joinShellArgs([
				"codex",
				"resume",
				dismissed.sessionId!,
				...(dangerouslySkipPermissions ? ["--dangerously-bypass-approvals-and-sandbox"] : []),
				"-c",
				`model_instructions_file=${instructionsFile}`,
			]);
		} else {
			cmd = joinShellArgs([
				"claude",
				"--resume",
				dismissed.sessionId!,
				...(dangerouslySkipPermissions ? ["--dangerously-skip-permissions"] : []),
				"--append-system-prompt-file",
				instructionsFile,
			]);
		}

		const runtimeId = runtime.spawn({
			name,
			guestType: dismissed.type,
			workDir: resumeWorkDir,
			command: cmd,
			salonDir,
			initialSessionId: dismissed.sessionId,
		});

		const guest: Guest = {
			name: dismissed.name,
			type: dismissed.type,
			runtimeId,
			sessionId: dismissed.sessionId,
			nonce: dismissed.nonce,
			startedAt: Date.now(),
			lifecycleStatus: "active",
			workspaceDir: resumeWorkDir,
			dangerouslySkipPermissions,
			ready: false,
		};

		return activateGuestLifecycle(guest, {
			dropDismissedRecord: true,
			reactivateArchivedDiscussions: true,
			persist: true,
		});
	}

	function autoResumeAllSuspendedGuests(): ResumeFailure[] {
		const failures: ResumeFailure[] = [];
		const suspended = Array.from(dismissedGuests.values()).filter(
			(g) => g.lifecycleStatus === "suspended" && g.sessionId,
		);
		for (const guest of suspended) {
			try {
				resumeInactiveGuest(guest.name);
			} catch (error) {
				// Leave as suspended; failure is reported in the recovery summary.
				const reason = error instanceof Error ? error.message : String(error);
				failures.push({ name: guest.name, reason });
			}
		}
		return failures;
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
			"Use 'codex' for code generation, making edits, executing changes. " +
			"Salon auto-generates a human-friendly guest name. " +
			"After inviting, you may call say_to_guest immediately — if startup is still in progress, delivery is queued automatically.",
		promptSnippet: "Invite a Claude Code or Codex CLI guest to the salon",
		promptGuidelines: [
			"Invite 'claude' for analysis, planning, code review, research, discussion",
			"Invite 'codex' for code generation, edits, implementations",
			"Guest names are assigned automatically from the salon name pool",
			"After invite_guest, you can say_to_guest immediately — do not wait for a ready notification because delivery queues automatically",
			"Use initial_message when you already know the first task to delegate",
			"Don't invite guests for simple questions you can answer directly",
			"Invite multiple guests when tasks benefit from parallel work or different perspectives",
		],
		parameters: Type.Object({
			type: Type.Union([Type.Literal("claude"), Type.Literal("codex")], { description: "Guest type" }),
			dangerously_skip_permissions: Type.Optional(Type.Boolean({
				description: "Launch the guest in bypass mode so Claude Code / Codex CLI skip permission prompts. Dangerous; use only when you explicitly want approvals and sandbox checks disabled.",
			})),
			initial_message: Type.Optional(Type.String({
				description: "Optional first message to send immediately after inviting. If the guest is still starting up, it will be queued automatically.",
			})),
		}),
		async execute(_id, params: any) {
			const dangerouslySkipPermissions = SALON_AUTONOMOUS ? true : params.dangerously_skip_permissions === true;
			const guest = activateGuestLifecycle(inviteGuest(
				undefined,
				params.type,
				workDir,
				salonDir,
				guestDir,
				runtime,
				{ dangerouslySkipPermissions },
			));
			scanCodexSessionId(guest);
			const initialMessageStatus = params.initial_message !== undefined
				? sayToGuest(guest, params.initial_message)
				: undefined;
			persistSalonState();

			const parts = [
				`Invited ${params.type} guest '${guest.name}' to the salon.`,
				"You may call say_to_guest immediately — do not wait for a ready notification; messages queue automatically until startup completes.",
			];
			if (initialMessageStatus === "sent") {
				parts.push(`Initial message sent to '${guest.name}'.`);
			} else if (initialMessageStatus === "queued") {
				parts.push(`Initial message queued for '${guest.name}'; it will be delivered automatically when startup completes.`);
			}

			return {
				content: [{ type: "text" as const, text: parts.join(" ") }],
				details: {},
			};
		},
	});

	pi.registerTool({
		name: "discuss",
		label: "Start Discussion",
		description:
			"Start a structured discussion on a topic. Reuses specified idle guests or invites two guests (default: one Claude Code + one Codex CLI for diverse perspectives) " +
			"who independently explore the topic, then cross-review each other's proposals. The host synthesizes at the end.",
		promptSnippet: "Start a structured discussion between two guests (default: claude + codex for cognitive diversity)",
		promptGuidelines: [
			"Use discuss for open-ended questions: architecture, design decisions, migration strategies, planning",
			"Default to discuss over answering alone for questions where you're not fully certain or where tradeoffs are non-obvious",
			"Discussions use one claude + one codex by default — different models produce genuinely different perspectives. Override only when there's a reason.",
			"Reuse an existing idle guest by passing guest_a_name or guest_b_name when they already have the right context.",
			"After the discussion completes, synthesize the proposals and reviews into a final recommendation",
		],
		parameters: Type.Object({
			topic: Type.String({ description: "Brief topic label for tracking the discussion" }),
			message: Type.String({ description: "The message to send to both guests — describe the task, provide context, ask the question. You decide how to frame it." }),
			guest_a_type: Type.Optional(Type.Union([Type.Literal("claude"), Type.Literal("codex")], {
				description: "Type for guest A when inviting a new guest (default: claude), or expected type when reusing an existing guest",
			})),
			guest_b_type: Type.Optional(Type.Union([Type.Literal("claude"), Type.Literal("codex")], {
				description: "Type for guest B when inviting a new guest (default: codex), or expected type when reusing an existing guest",
			})),
			guest_a_name: Type.Optional(Type.String({ description: "Existing idle guest to reuse for guest A" })),
			guest_b_name: Type.Optional(Type.String({ description: "Existing idle guest to reuse for guest B" })),
		}),
		async execute(_id, params: any) {
			const requestedTypeA = typeof params.guest_a_type === "string" ? params.guest_a_type as GuestType : undefined;
			const requestedTypeB = typeof params.guest_b_type === "string" ? params.guest_b_type as GuestType : undefined;
			const typeA = requestedTypeA || "claude";
			const typeB = requestedTypeB || "codex";
			const discId = `disc_${Date.now()}`;

			const inviteDiscussionGuest = (type: GuestType): Guest => {
				const guest = activateGuestLifecycle(inviteGuest(
					undefined,
					type,
					workDir,
					salonDir,
					guestDir,
					runtime,
					{ dangerouslySkipPermissions: SALON_AUTONOMOUS },
				));
				scanCodexSessionId(guest);
				return guest;
			};

			const guestA = resolveDiscussionGuest({
				name: typeof params.guest_a_name === "string" ? params.guest_a_name : undefined,
				inviteType: typeA,
				expectedType: requestedTypeA,
				activeGuests: guests,
				guestDiscussions: guestToDiscussion,
				getStatus: getGuestDisplayStatus,
				invite: inviteDiscussionGuest,
			});
			const guestB = resolveDiscussionGuest({
				name: typeof params.guest_b_name === "string" ? params.guest_b_name : undefined,
				inviteType: typeB,
				expectedType: requestedTypeB,
				activeGuests: guests,
				guestDiscussions: guestToDiscussion,
				getStatus: getGuestDisplayStatus,
				invite: inviteDiscussionGuest,
			});
			if (guestA.name === guestB.name) {
				throw new Error(`Discussion requires two distinct guests. '${guestA.name}' was selected twice.`);
			}
			const nameA = guestA.name;
			const nameB = guestB.name;

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

			if (!guests.has(targetDisc.guestA) || !guests.has(targetDisc.guestB)) {
				throw new Error("Discussion guests no longer available");
			}

			if (targetDisc.currentRound.responses.size > 0) {
				throw new Error(`Discussion "${params.topic}" is still waiting for guest responses in the current round. Wait for both guests to respond before advancing.`);
			}

			const action = params.action as AdvanceAction;
			const { commands } = discussionAdvance(targetDisc, action, params.message);

			if (action === "continue") {
				dispatchDiscussionCommands(commands);
				return {
					content: [{ type: "text" as const, text: `Debate continues — round ${targetDisc.rounds.length + 1} started.` }],
					details: {},
				};
			}

			if (action === "synthesize") {
				dispatchDiscussionCommands(commands);
				const summary = buildDiscussionSummary(targetDisc);
				return {
					content: [{ type: "text" as const, text: `Discussion "${params.topic}" moved to synthesis stage. Write your synthesis and use submit_synthesis.\n\n${summary}` }],
					details: {},
				};
			}

			if (action === "ask_user") {
				const summary = buildDiscussionSummary(targetDisc);
				cleanupDiscussion(targetId, targetDisc);
				dispatchDiscussionCommands(commands);
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
			let targetDisc: Discussion | undefined;
			for (const [, disc] of discussions) {
				if (disc.topic === params.topic && disc.stage === "synthesizing") {
					targetDisc = disc;
					break;
				}
			}
			if (!targetDisc) {
				throw new Error(`No discussion in synthesizing stage for topic "${params.topic}"`);
			}

			if (!guests.has(targetDisc.guestA) || !guests.has(targetDisc.guestB)) {
				throw new Error("Discussion guests no longer available");
			}

			const { commands } = submitSynthesisToGuests(targetDisc, params.synthesis);
			dispatchDiscussionCommands(commands);

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
			const { commands } = discussionFinalize(targetDisc);
			cleanupDiscussion(targetId, targetDisc);
			dispatchDiscussionCommands(commands);
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
			if (guest.lifecycleStatus !== "active") throw new Error(`Guest '${params.name}' is not accepting new messages right now.`);
			const sendStatus = sayToGuest(guest, params.message);
			return {
				content: [{
					type: "text" as const,
					text: sendStatus === "sent"
						? `Sent to '${params.name}'.`
						: `Queued for '${params.name}'; it will be delivered automatically when startup completes.`,
				}],
				details: {},
			};
		},
	});

	pi.registerTool({
		name: "list_guests",
		label: "List Guests",
		description: "List all guests in the salon — active, suspended, and dismissed — with their status.",
		promptSnippet: "List guests in the salon with status",
		parameters: Type.Object({}),
		async execute() {
			if (guests.size === 0 && dismissedGuests.size === 0) {
				return { content: [{ type: "text" as const, text: "No guests in the salon." }], details: {} };
			}
			const lines: string[] = [];
			for (const g of guests.values()) {
				const status = getGuestDisplayStatus(g);
				const discId = guestToDiscussion.get(g.name);
				const disc = discId ? discussions.get(discId) : undefined;
				const discLabel = disc ? ` [discussing: ${disc.stage}]` : "";
				lines.push(`${g.name} (${g.type}) ${status}${discLabel} @ ${g.workspaceDir}`);
			}
			for (const g of dismissedGuests.values()) {
				const resumable = g.sessionId ? " (resumable)" : "";
				lines.push(`${g.name} (${g.type}) ${g.lifecycleStatus}${resumable} @ ${g.workspaceDir}`);
			}
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
			if (guest.lifecycleStatus === "dismissing") {
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
			const suspendedGuests = Array.from(dismissedGuests.values()).filter((guest) => guest.lifecycleStatus === "suspended");
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

	if (SALON_AUTONOMOUS) {
		pi.registerTool({
			name: "finish_task",
			label: "Finish Task",
			description: "Signal that the autonomous task is complete or cannot proceed further.",
			promptSnippet: "Finish the autonomous task and write the result file",
			parameters: Type.Object({
				status: Type.Union([
					Type.Literal("solved"),
					Type.Literal("incomplete"),
					Type.Literal("blocked"),
				], { description: "Final autonomous task status" }),
				summary: Type.String({ description: "Short summary of what was achieved" }),
				verification_summary: Type.Optional(Type.String({
					description: "Optional summary of verification performed or remaining gaps",
				})),
			}),
			async execute(_id, params: any) {
				if (!SALON_RESULT_FILE) {
					return {
						content: [{ type: "text" as const, text: "SALON_RESULT_FILE is not configured." }],
						details: {},
					};
				}

				const trackedGuests = new Map<string, GuestRecord>();
				for (const guest of guests.values()) {
					trackedGuests.set(guest.name, guest);
				}
				for (const guest of dismissedGuests.values()) {
					if (!trackedGuests.has(guest.name)) {
						trackedGuests.set(guest.name, guest);
					}
				}
				for (const guest of trackedGuests.values()) {
					refreshGuestQuantState(guest);
				}

				const guestUsage = Object.fromEntries(
					Array.from(guestQuantStates.entries()).map(([name, state]) => [
						name,
						{
							input_tokens: state.totalInputTokens,
							output_tokens: state.totalOutputTokens,
						},
					]),
				);

				mkdirSync(dirname(SALON_RESULT_FILE), { recursive: true });
				writeFileSync(
					SALON_RESULT_FILE,
					JSON.stringify({
						status: params.status,
						summary: params.summary,
						verification_summary: params.verification_summary,
						finished_at: new Date().toISOString(),
						guests: guestUsage,
					}, null, 2),
				);

				await teardownSalonSession({ killTmuxSession: true });
				process.exit(0);
			},
		});
	}

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

- **Claude Code guests** tend to excel at **fine-grained cross-review and analytical layering**: dissecting proposals into sub-cases, identifying where a blanket judgment needs nuance, and revising their own positions clearly when challenged. Their initial assessments tend to under-probe — accepting surface adequacy where deeper scrutiny would reveal issues. Their initial exploration produces a mix of solid findings and under-examined calls; cross-review is where the soft calls get corrected and the solid ones sharpened.

- **Codex CLI guests** tend to excel at **system-level risk assessment and priority ranking**: identifying which problems have the largest blast radius, tracing consequence chains (e.g., "error swallowing → observability loss → state divergence"), and catching functional regressions during code review. They tend to be more conservative in assessment but can over-engineer solutions (e.g., proposing new lifecycle states where a simple check suffices). Their macro-level judgment on "what matters most" is typically stronger, but specific implementation proposals sometimes need to be pulled back to simpler alternatives.

These are complementary perspectives — they tend to err in different directions. Claude Code may initially underrate a problem; Codex CLI may propose an overly complex fix. Cross-review between the two reliably converges to a better position than either alone. Use this to guide guest selection:
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
- After invite_guest, send the first message immediately when you know the task. Do not wait for a ready notification — messages queue and flush automatically when startup completes.
- A guest receiving an execution task should understand the full intent, not just a list of file changes.

When relaying a guest's words (to the user or to another guest):
- Quote or preserve the original expression faithfully. Do not rephrase, summarize, or rewrite it.
- You may add your own commentary, intent, or framing around the quote, but keep the guest's own words intact.

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

## Guest lifecycle
Guests persist after their task or discussion completes — finalize_discussion does NOT dismiss them. Prefer reusing an existing guest who already has context over inviting a new one. Only invite a new guest when you need a fresh perspective or the existing guest's context is irrelevant.

## Task workflow state machine

For each task, follow this state machine. You judge when to advance — you can skip states for simple tasks, but never skip REVIEW before COMMIT.

### Triage: classify the task

Before starting work, classify:

- **No-code**: Pure analysis, discussion, or question — no files to change. Go directly to done, or to planning if discuss is needed.
- **Small change**: Local, well-scoped, clear spec, low blast radius, cheap to verify. Flow: triage → executing → reviewing → done.
- **Large change**: Needs design choices, spans multiple modules, unclear requirements, expensive to verify, or likely to consume substantial context. Flow: triage → planning → executing → reviewing → done.

Classify by **context volume + blast radius + verification cost**, not by diff size. A 10-line change to a state machine is large; a 100-line mechanical rename is small.

Tell the user which path you're taking and why.

### States and transitions

\`\`\`text
triage
 ├─→ ask_user              (requirements unclear)
 ├─→ done                  (no-code, answer directly)
 ├─→ executing             (small change)
 └─→ planning              (large / ambiguous)

planning
 ├─→ ask_user
 ├─→ done                  (design-only answer)
 └─→ executing

executing
 ├─→ reviewing
 └─→ ask_user

reviewing
 ├─→ done                  (approved)
 ├─→ fixing                (implementation issues)
 ├─→ planning              (plan wrong / incomplete)
 └─→ ask_user

fixing
 ├─→ confirming
 ├─→ planning              (fix implies redesign)
 └─→ ask_user

confirming
 ├─→ done                  (fixes verified)
 ├─→ fixing                (still issues)
 ├─→ planning              (design premise broken)
 └─→ ask_user
\`\`\`

From any phase, transition to ask_user if a blocking requirement, product decision, or ambiguity prevents good work.

Commit is not a state — it happens only after done, and only when the user explicitly asks.

### Role separation rules

Three hard rules:
1. For large changes, the planner and executor must be different guests.
2. For all changes, the reviewer must not be the executor.
3. Review findings go back to the executor for fixes. Do not ask the reviewer to implement their own findings unless you explicitly reassign roles.

For large changes, this typically means a **two-person** setup: planner/reviewer (one guest) + executor (another guest). You do not need a third person — the planner of record normally serves as reviewer.

For small changes, the planner may also be the executor, but the reviewer must still be a different guest.

### Planning rules

- Use \`discuss\` for large or ambiguous changes.
- After planning converges, choose a **planner of record**. That guest owns the accepted plan and should normally perform review and confirmation.
- Write a **plan brief** — a concise summary of what to build, which files to change, and key decisions. Send this to the executor, not the full discussion transcript.
- For large changes, do not let the planning guest silently drift into execution. Preserve context hygiene by handing the accepted plan to a separate executor.

### Executing rules

- For large changes, prefer a fresh executor with a clean context window instead of reusing the planner.
- Brief the executor with their role, the plan brief, and clear boundaries.

### Review and fix loop

- \`reviewing\`: Full review against the plan and code quality standards.
- \`fixing\`: Executor addresses review findings. Distill findings into actionable items — don't dump raw review output.
- \`confirming\`: Same reviewer verifies fixes are adequate. This is targeted verification ("did these specific issues get fixed?"), not a full re-review.
- If the fix-confirm cycle exceeds 2 rounds on the same set of issues, consider whether the problem is in the plan rather than the implementation. Transition back to planning rather than continuing to iterate.

### Phase transitions

At each state transition, briefly tell the user the current phase and role assignments. This serves as both user notification and your own checkpoint.

### Briefing guests

When delegating work, explicitly assign a role and boundary:

\`\`\`
ROLE: planner | executor | reviewer
PHASE: <current phase>
GOAL: <what good output looks like>
BOUNDARY: <what the guest should not do>
SUCCESS CRITERIA: <how completion will be judged>
\`\`\`

## Waiting for guests
Guest responses are delivered to you automatically — you do NOT need to poll, check, or call list_guests in a loop. After sending a task via say_to_guest, inviting with initial_message, or starting a discuss, simply finish your current response. When a guest replies, it will appear as your next input message (e.g. [guest-name]: ...). Do nothing until then.

## Keeping the user informed
- Briefly tell the user what you're doing and why when starting collaboration
- When guest responses arrive, distill the key insights — don't dump raw output
- If a guest's recommendation conflicts with the user's previously stated intent, constraints, or decisions, call out the conflict explicitly instead of silently siding with the guest
- Present your synthesis with your own judgment, not as a neutral relay

# Message format

Messages from guests arrive as: [guest-name]: content
Discussion status updates arrive as: [salon] content

When these appear, process them thoughtfully — don't just echo them to the user. Add your perspective, context, or next steps.

`;
		const autonomousPreamble = SALON_AUTONOMOUS
			? `
# Autonomous mode

You are in AUTONOMOUS mode. No human is in the loop. A Python adapter monitors your progress and will kill this session on timeout.

## Overrides to normal behavior
- NEVER call ask_user. If you would normally escalate to the user, make your best judgment and proceed. If truly blocked, call finish_task with status "blocked".
- invite_guest automatically forces dangerously_skip_permissions=true.
- Skip all user-facing narration. Do not explain state transitions, do not summarize guest output for "the user." Minimize your own text output — focus on tool calls and guest coordination.
- You MUST NOT use your own file tools (read, write, edit, bash, grep, glob) to work on the task directly.
  You are a coordinator only. All task work must be done by guests via tb.
- You MUST invite at least one guest before making progress on the task.
  The only tools you should use directly are: invite_guest, say_to_guest, discuss,
  advance_discussion, submit_synthesis, finalize_discussion, finish_task, list_guests,
  dismiss_guest, and resume_guest.
- When briefing guests, relay the task description verbatim.
  Do NOT rephrase paths, filenames, input formats, or calling conventions.
  The task description is the source of truth. If it says /app/output.npy,
  that is where the artifact must be placed — do not invent alternative paths.
- Before calling finish_task(status="solved"), verify the expected artifact
  exists at the benchmark-specified path:
    tb exec -- 'ls -lh /app/<expected-artifact>'
  If the artifact does not exist at the correct path, do NOT call finish_task(solved).
  Fix the path first.

## Container access
All work happens inside the task container, accessed via the tb bridge.

Guests must use the tb tool exactly as documented in their brief:
  tb exec -- 'bash command'
  tb exec --timeout 60 -- 'cmd'
  tb read /app/file.py
  tb write /app/file.py
  tb ls /app

Guests must NOT invoke Docker directly, use ssh, or use their native Read/Edit/Grep/Bash tools on the host filesystem — those operate outside the container.
All container inspection and mutation must go through tb.

If tb fails because the bridge/socket is unavailable or container access is broken, call finish_task(status="blocked") immediately.

## Capability preflight (run before assigning roles)
Each guest must verify container access AND write capability:
  tb exec -- 'echo access_ok && echo ok > /tmp/__probe && rm /tmp/__probe'

If a guest fails this check, do NOT assign them container write tasks.
Reassign them to analysis/planning/review only.
If BOTH guests fail: call finish_task(blocked) immediately.

## Workflow
1. Always invite 2 guests: one Claude Code guest and one Codex guest.
   Run capability preflight for both. Then:
   - If both pass: assign one as executor, one as reviewer.
   - If one fails: assign the failing guest to analysis/planning only; the other handles all container writes.
   - If both fail: call finish_task(blocked) immediately.
   Do NOT let a blocked guest occupy executor slot while doing nothing.
2. For tasks requiring design: use discuss, then assign executor + reviewer.
3. For straightforward tasks: assign one guest as executor, other as reviewer.
4. Artifact-first: For tasks requiring output files, write a best-effort version
   to the target path within the first 3-4 tb rounds, then iterate.
   A partial /app/output.npy that exists beats a perfect analysis that never gets written.
5. After execution: have the reviewer verify inside the container (run tests, check output files, inspect results).
6. Call finish_task based on verification outcome.

## Reviewer acceptance checklist
Before approving, verify ALL acceptance criteria:
1. The expected artifact exists at the benchmark-specified path (check with ls /app/)
2. If the task directory contains a test harness (/tests/, pytest.ini, run-tests.sh),
   run it: tb exec -- 'cd /app && python -m pytest -q 2>&1 | tail -20'
3. For tasks requiring "unchanged" output (e.g., filtering, transformation),
   verify the unchanged-input invariant holds on a sample of clean inputs
4. Do NOT only validate the specific cases you designed — validate what the benchmark validates
5. For tasks involving extraction, inference, or learning:
   - Do NOT validate only against the visible instance (e.g., visible forward.py, visible weights)
   - Test with at least one alternative input (different seed, shape, or data)
   - Verify output dimensions/schema match the task contract, not just the currently visible example
   - A solution that only works on what you can see is NOT a solution

## Termination — call finish_task promptly

finish_task(status="solved"):
  Verification commands pass, or strong evidence the task requirements are met.

finish_task(status="incomplete"):
  Partial progress was made. Use after: 2 fix-review cycles failed on the same issue, or the approach works partially but a specific sub-problem remains unsolved.

finish_task(status="blocked"):
  No viable path forward. Use when: tb fails, no guest can make progress, the same error class repeats 3+ times, or you have exhausted meaningfully distinct approaches.

## Hard limits
- Do not run more than 2 fix-review cycles on the same issue. After 2 rounds, call finish_task with the current state.
- Do not invite more than 2 guests total.
- If a guest produces the same category of error 3 consecutive times, switch to the other guest or call finish_task.
- Aim to reach finish_task within roughly 8 host turns. Beyond 10 turns, you are likely looping — call finish_task.

`
			: "";
		// Replace pi's default identity line with salon context
		const basePrompt = event.systemPrompt.replace(
			/^You are an expert coding assistant operating inside pi, a coding agent harness\. You help users by reading files, executing commands, editing code, and writing new files\.\n*/,
			"",
		);
		const resumeSummary = pendingResumeSummary
			? `\n# Recovered salon state after resume\n${pendingResumeSummary}\n`
			: "";
		pendingResumeSummary = undefined;
		return { systemPrompt: hostPreamble + autonomousPreamble + resumeSummary + basePrompt };
	});

	pi.on("context", (event) => {
		const messages = event.messages.filter((message) => !isSalonStatusContextMessage(message));
		const salonStatusSnapshot = buildSalonStatusSnapshot();
		if (!salonStatusSnapshot) {
			lastSalonStatusSnapshot = undefined;
			lastSalonStatusTimestamp = undefined;
			return { messages };
		}
		if (salonStatusSnapshot !== lastSalonStatusSnapshot || lastSalonStatusTimestamp === undefined) {
			lastSalonStatusSnapshot = salonStatusSnapshot;
			lastSalonStatusTimestamp = Date.now();
		}
		messages.push(createSalonStatusContextMessage(salonStatusSnapshot, lastSalonStatusTimestamp));
		return { messages };
	});

	pi.on("before_provider_request", (event) => {
		return retargetAnthropicSalonStatusCacheBreakpoint(event.payload);
	});

	// ── Receive guest responses via Unix socket ──────────────────────
	const socketPath = join(salonDir, "salon.sock");
	let messageServer: Server | undefined;
	let ownsMessageSocket = false;

	function unlinkIfExists(path: string) {
		if (!existsSync(path)) return;
		unlinkSync(path);
	}

	async function closeSalonMessageServer() {
		const server = messageServer;
		const ownedSocket = ownsMessageSocket;
		messageServer = undefined;
		ownsMessageSocket = false;

		if (server) {
			await new Promise<void>((resolve, reject) => {
				server.close((error) => {
					if (error) {
						reject(error);
						return;
					}
					resolve();
				});
			});
		}

		if (!ownedSocket) return;

		if (readHostPidForSocket(socketPath) === process.pid) {
			unlinkIfExists(hostPidPath);
		}
		unlinkIfExists(socketPath);
	}

	function restoreSalonSession(ctx: { sessionManager: { getBranch(): Array<{ type?: string; customType?: string; data?: unknown }> } }) {
		clearRuntimeState();
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
			const resumeFailures = autoResumeAllSuspendedGuests();
			pendingResumeSummary = buildRecoveredSalonSummary(resumeFailures);
		}
	}

	async function openSalonMessageServer() {
		await closeSalonMessageServer();
		messageServer = await startMessageServer(socketPath, (msg) => {
			// Handle guest lifecycle events
			if (msg.from === "_system" && msg.content.startsWith("guest_ready:")) {
				const name = msg.content.slice("guest_ready:".length);
				markGuestReady(name);
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
				const { inactiveGuest, transitionedFromActive, droppedQueuedCount } = transitionGuestToInactive(name, sessionId);
				if (inactiveGuest && transitionedFromActive) {
					try {
						runtime.equalize();
					} catch {
						// The tmux session may already be shutting down; the guest state update above is the important part.
					}
					// Don't notify the host LLM about host-initiated exits (session teardown).
					// Sending a followUp during session_before_switch starts an agent turn whose
					// agent_end event is lost when the framework disconnects/reconnects the agent
					// subscription, leaving the "Working..." spinner stuck forever.
					if (inactiveGuest.lifecycleStatus !== "suspended") {
						const resumeHint = inactiveGuest.sessionId ? ` Session saved — use resume_guest to bring them back.` : "";
						const queueHint = droppedQueuedCount > 0 ? ` ${droppedQueuedCount} queued message(s) were never delivered.` : "";
						pi.sendUserMessage(`[salon] Guest '${name}' has left the salon.${resumeHint}${queueHint}`, { deliverAs: "followUp" });
					}
				}
				return;
			}

			const respondingGuest = guests.get(msg.from);
			const { stripped: cleanContent, report } = stripSalonReport(msg.content);
			if (respondingGuest) {
				respondingGuest.eventStatus = "idle";
				refreshGuestQuantState(respondingGuest);
				if (report) {
					updateGuestContextState(respondingGuest.name, report);
				}
			}
			trackGuestReportPresence(respondingGuest?.name, !!report);

			const handled = handleDiscussionMessage(msg.from, cleanContent);
			if (!handled) {
				pi.sendUserMessage(`[${msg.from}]: ${cleanContent}`, { deliverAs: "followUp" });
			}
		});
		ownsMessageSocket = true;
		writeFileSync(hostPidPath, String(process.pid));
	}

	async function teardownSalonSession(options: { killTmuxSession: boolean }) {
		const exitWaits: Promise<void>[] = [];
		for (const guest of guests.values()) {
			if (guest.lifecycleStatus === "active") {
				exitWaits.push(beginGuestDismissal(guest, "host"));
			} else if (guest.lifecycleStatus === "dismissing") {
				guest.teardownReason = guest.teardownReason || "host";
				exitWaits.push(ensureGuestExitWaiter(guest));
			}
		}

		await Promise.race([
			Promise.all(exitWaits),
			new Promise<void>((resolve) => setTimeout(resolve, 5000)),
		]);

		for (const [name, guest] of Array.from(guests.entries())) {
			if (guest.lifecycleStatus !== "dismissing") continue;
			transitionGuestToInactive(name, undefined, {
				persist: false,
				runtimeFileMode: "ifSessionTracked",
			});
		}
		persistSalonState();

		await closeSalonMessageServer();
		if (options.killTmuxSession) {
			runtime.destroySession();
		}
	}

	pi.on("session_before_switch", async (_event, ctx) => {
		if (ctx.hasUI) {
			ctx.ui.notify("Dismissing active salon guests before switching sessions.", "info");
		}
		await teardownSalonSession({ killTmuxSession: false });
		return { cancel: false };
	});

	pi.on("session_start", async (_event, ctx) => {
		restoreSalonSession(ctx);
		await openSalonMessageServer();
		if (SALON_AUTONOMOUS && SALON_TASK_FILE && existsSync(SALON_TASK_FILE)) {
			const task = readFileSync(SALON_TASK_FILE, "utf8");
			await pi.sendUserMessage(task, { deliverAs: "followUp" });
		}
	});

	pi.on("session_switch", async (_event, ctx) => {
		restoreSalonSession(ctx);
		await openSalonMessageServer();
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

	// ── Graceful shutdown ─────────────────────────────────────────────
	pi.on("session_shutdown", async () => {
		await teardownSalonSession({ killTmuxSession: true });
	});

	pi.registerCommand("next", {
		description: "Jump to the next guest waiting for input (approval)",
		handler: async (_args, ctx) => {
				for (const [, guest] of guests) {
					if (guest.lifecycleStatus !== "active") continue;
					if (runtime.getStatus(guest.runtimeId) === "input") {
						try {
							runtime.focus(guest.runtimeId);
							ctx.ui.notify(`Switched to ${guest.name} (needs input)`, "info");
						} catch {
							ctx.ui.notify(`Guest ${guest.name} is no longer available.`, "warning");
						}
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
	formatRecoveredSalonSummary,
	sanitizeGuestName,
	inviteGuest,
	getGuestForwardDir,
	getGuestForwardArmedPath,
	createGuestForwardTicket,
	clearGuestForwardState,
	resolveDiscussionGuest,
	sayToGuestImpl,
	flushQueuedGuestMessagesImpl,
	startMessageServer,
	guests,
	guestToDiscussion,
	queuedGuestMessages,
};
