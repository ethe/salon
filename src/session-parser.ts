import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface GuestQuantState {
	lastTurnPromptTokens?: number;
	lastTurnOutputTokens?: number;
	totalInputTokens: number;
	totalOutputTokens: number;
	contextWindowSize?: number;
	contextUtilization?: number;
	compactionCount: number;
	lastCompactedAt?: number;
	turnCount: number;
	sessionLogPath?: string;
	sessionLogOffset: number;
}

interface ClaudeUsagePayload {
	input_tokens?: number;
	output_tokens?: number;
	cache_read_input_tokens?: number;
	cache_creation_input_tokens?: number;
}

interface ClaudeAssistantEntry {
	type?: string;
	message?: {
		usage?: ClaudeUsagePayload;
		model?: string;
	};
}

interface CodexTokenUsage {
	input_tokens?: number;
	output_tokens?: number;
}

interface CodexTokenInfo {
	last_token_usage?: CodexTokenUsage;
	model_context_window?: number;
}

interface CodexEventEntry {
	type?: string;
	timestamp?: string | number;
	payload?: {
		type?: string;
		timestamp?: string | number;
		info?: CodexTokenInfo | null;
	};
}

const CLAUDE_CONTEXT_WINDOWS: Array<[string, number]> = [
	["claude-opus-4-6", 1_000_000],
	["claude-sonnet-4-6", 1_000_000],
	["claude-opus-4-5", 200_000],
	["claude-sonnet-4-5", 200_000],
	["claude-opus-4-1", 200_000],
	["claude-opus-4", 200_000],
	["claude-sonnet-4", 200_000],
	["claude-3-7-sonnet", 200_000],
	["claude-3-5-sonnet", 200_000],
	["claude-3-5-haiku", 200_000],
	["claude-3-opus", 200_000],
	["claude-3-sonnet", 200_000],
	["claude-3-haiku", 200_000],
];

export function createGuestQuantState(): GuestQuantState {
	return {
		compactionCount: 0,
		totalInputTokens: 0,
		totalOutputTokens: 0,
		turnCount: 0,
		sessionLogOffset: 0,
	};
}

export function resolveClaudeSessionLogPath(sessionId: string, workDir: string): string | undefined {
	const slug = workDir.replace(/[\\/]/g, "-");
	const filePath = join(homedir(), ".claude", "projects", slug, `${sessionId}.jsonl`);
	return existsSync(filePath) ? filePath : undefined;
}

export function readNewLines(filePath: string, offset: number): { lines: string[]; newOffset: number } {
	let fd: number | undefined;
	try {
		if (!existsSync(filePath)) {
			return { lines: [], newOffset: offset };
		}
		const stats = statSync(filePath);
		const start = offset > stats.size ? 0 : offset;
		const bytesToRead = Math.max(0, stats.size - start);
		if (bytesToRead === 0) {
			return { lines: [], newOffset: start };
		}
		fd = openSync(filePath, "r");
		const buffer = Buffer.allocUnsafe(bytesToRead);
		const bytesRead = readSync(fd, buffer, 0, bytesToRead, start);
		if (bytesRead <= 0) {
			return { lines: [], newOffset: start };
		}
		const chunk = buffer.toString("utf8", 0, bytesRead);
		if (chunk.length === 0) {
			return { lines: [], newOffset: start + bytesRead };
		}

		const trailingNewline = chunk.endsWith("\n");
		const rawLines = chunk.split("\n");
		if (trailingNewline && rawLines[rawLines.length - 1] === "") {
			rawLines.pop();
		}

		if (!trailingNewline) {
			rawLines.pop();
		}

		const completeChunk = rawLines.join("\n");
		const consumedBytes = Buffer.byteLength(completeChunk, "utf8") + (rawLines.length > 0 ? 1 : 0);
		const newOffset = trailingNewline ? start + bytesRead : start + consumedBytes;
		return {
			lines: rawLines.filter((line) => line.length > 0),
			newOffset,
		};
	} catch {
		return { lines: [], newOffset: offset };
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

function lookupClaudeContextWindow(model: string | undefined): number | undefined {
	if (!model) return undefined;
	const normalized = model.toLowerCase();
	for (const [prefix, windowSize] of CLAUDE_CONTEXT_WINDOWS) {
		if (normalized.startsWith(prefix) || normalized.includes(`.${prefix}`)) {
			return windowSize;
		}
	}
	return undefined;
}

function parseTimestampMs(value: unknown): number | undefined {
	if (typeof value !== "string" && typeof value !== "number") return undefined;
	const parsed = Date.parse(String(value));
	return Number.isFinite(parsed) ? parsed : undefined;
}

function updateContextUtilization(state: GuestQuantState) {
	if (
		state.lastTurnPromptTokens === undefined ||
		state.contextWindowSize === undefined ||
		state.contextWindowSize <= 0
	) {
		state.contextUtilization = undefined;
		return;
	}
	state.contextUtilization = state.lastTurnPromptTokens / state.contextWindowSize;
}

function recordCompaction(state: GuestQuantState, timestampMs: number | undefined) {
	if (
		timestampMs !== undefined &&
		state.lastCompactedAt !== undefined &&
		Math.abs(timestampMs - state.lastCompactedAt) <= 1000
	) {
		return;
	}
	state.compactionCount += 1;
	state.lastCompactedAt = timestampMs ?? state.lastCompactedAt;
}

export function parseClaudeSessionLines(lines: string[], state: GuestQuantState): GuestQuantState {
	const nextState: GuestQuantState = { ...state };
	for (const line of lines) {
		try {
			const entry = JSON.parse(line) as ClaudeAssistantEntry;
			if (entry.type !== "assistant" || !entry.message?.usage) continue;
			const usage = entry.message.usage;
			nextState.lastTurnPromptTokens =
				(usage.input_tokens ?? 0) +
				(usage.cache_read_input_tokens ?? 0) +
				(usage.cache_creation_input_tokens ?? 0);
			nextState.lastTurnOutputTokens = usage.output_tokens;
			nextState.totalInputTokens += nextState.lastTurnPromptTokens;
			nextState.totalOutputTokens += nextState.lastTurnOutputTokens ?? 0;
			nextState.turnCount += 1;
			const contextWindowSize = lookupClaudeContextWindow(entry.message.model);
			if (contextWindowSize !== undefined) {
				nextState.contextWindowSize = contextWindowSize;
			}
			updateContextUtilization(nextState);
		} catch {
			// Ignore malformed/incomplete JSONL records.
		}
	}
	return nextState;
}

export function parseCodexSessionLines(lines: string[], state: GuestQuantState): GuestQuantState {
	const nextState: GuestQuantState = { ...state };
	for (const line of lines) {
		try {
			const entry = JSON.parse(line) as CodexEventEntry;
			if (entry.type === "turn_context") {
				nextState.turnCount += 1;
				continue;
			}
			if (entry.type === "compacted") {
				recordCompaction(nextState, parseTimestampMs(entry.timestamp));
				continue;
			}
			if (entry.type !== "event_msg" || !entry.payload) continue;
			if (entry.payload.type === "token_count" && entry.payload.info) {
				const usage = entry.payload.info.last_token_usage;
				const inputTokens = usage?.input_tokens;
				if (typeof inputTokens === "number") {
					nextState.lastTurnPromptTokens = inputTokens;
					nextState.totalInputTokens += inputTokens;
				}
				if (typeof usage?.output_tokens === "number") {
					nextState.lastTurnOutputTokens = usage.output_tokens;
					nextState.totalOutputTokens += usage.output_tokens;
				}
				if (typeof entry.payload.info.model_context_window === "number") {
					nextState.contextWindowSize = entry.payload.info.model_context_window;
				}
				updateContextUtilization(nextState);
				continue;
			}
			if (entry.payload.type === "context_compacted") {
				recordCompaction(nextState, parseTimestampMs(entry.payload.timestamp ?? entry.timestamp));
			}
		} catch {
			// Ignore malformed/incomplete JSONL records.
		}
	}
	return nextState;
}

export function updateGuestQuantState(type: "claude" | "codex", state: GuestQuantState): GuestQuantState {
	if (!state.sessionLogPath) {
		return state;
	}
	const { lines, newOffset } = readNewLines(state.sessionLogPath, state.sessionLogOffset);
	const nextState: GuestQuantState = { ...state, sessionLogOffset: newOffset };
	if (lines.length === 0) {
		return nextState;
	}
	return type === "claude"
		? parseClaudeSessionLines(lines, nextState)
		: parseCodexSessionLines(lines, nextState);
}
