/**
 * Post-install setup — installs hooks into Claude Code and Codex CLI configs.
 *
 * Runs automatically via `npm run setup` / `postinstall`.
 * Safe to re-run: updates stale paths and skips if already current.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const SCRIPT_DIR = resolve(import.meta.dirname, "..");
const hookPath = join(SCRIPT_DIR, "hooks", "agent-response.sh");

type ClaudeHook = { type?: string; command?: string };
type ClaudeHookEntry = { matcher?: string; hooks?: ClaudeHook[] };
type ClaudeSettings = {
	hooks?: Record<string, ClaudeHookEntry[]>;
	[key: string]: unknown;
};

function makeClaudeHookEntry(): ClaudeHookEntry {
	return { matcher: "", hooks: [{ type: "command", command: hookPath }] };
}

function normalizeClaudeHookEntries(entries: ClaudeHookEntry[] | undefined, eventName: "Stop" | "UserPromptSubmit") {
	const normalizedEntries = Array.isArray(entries) ? entries : [];
	let hasCurrentHook = false;
	let changed = !Array.isArray(entries);

	for (const entry of normalizedEntries) {
		if (!Array.isArray(entry.hooks)) continue;
		for (let i = 0; i < entry.hooks.length; i++) {
			const hook = entry.hooks[i];
			const command = hook.command;
			if (!command) continue;
			if (eventName === "Stop" && (command.includes("claude-stop.sh") || command.includes("planner-stop.sh"))) {
				entry.hooks.splice(i, 1);
				i--;
				changed = true;
				continue;
			}
			if (command === hookPath || command.includes("agent-response.sh")) {
				if (!hasCurrentHook) {
					hasCurrentHook = true;
					if (command !== hookPath || hook.type !== "command") {
						entry.hooks[i] = { type: "command", command: hookPath };
						changed = true;
					}
				} else {
					entry.hooks.splice(i, 1);
					i--;
					changed = true;
				}
			}
		}
	}

	if (!hasCurrentHook) {
		normalizedEntries.push(makeClaudeHookEntry());
		changed = true;
	}

	return { entries: normalizedEntries, changed };
}

// Claude Code: Stop + UserPromptSubmit hooks in ~/.claude/settings.json
(() => {
	const settingsDir = join(process.env.HOME!, ".claude");
	const settingsFile = join(settingsDir, "settings.json");
	mkdirSync(settingsDir, { recursive: true });

	if (existsSync(settingsFile)) {
		const settings = JSON.parse(readFileSync(settingsFile, "utf-8")) as ClaudeSettings;
		settings.hooks = settings.hooks || {};

		const normalizedStop = normalizeClaudeHookEntries(settings.hooks.Stop, "Stop");
		const normalizedPromptSubmit = normalizeClaudeHookEntries(settings.hooks.UserPromptSubmit, "UserPromptSubmit");

		if (!normalizedStop.changed && !normalizedPromptSubmit.changed) return;

		settings.hooks.Stop = normalizedStop.entries;
		settings.hooks.UserPromptSubmit = normalizedPromptSubmit.entries;
		writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
	} else {
		writeFileSync(settingsFile, JSON.stringify({
			hooks: {
				Stop: [makeClaudeHookEntry()],
				UserPromptSubmit: [makeClaudeHookEntry()],
			},
		}, null, 2));
	}

	console.log("salon: Claude Code Stop/UserPromptSubmit hooks installed");
})();

// Codex CLI: notify in ~/.codex/config.toml
(() => {
	const codexConfigDir = join(process.env.HOME!, ".codex");
	const codexConfigFile = join(codexConfigDir, "config.toml");
	mkdirSync(codexConfigDir, { recursive: true });

	if (existsSync(codexConfigFile)) {
		let content = readFileSync(codexConfigFile, "utf-8");

		// Already up-to-date
		if (content.includes(hookPath)) return;

		// Replace stale entry
		if (content.match(/^notify\s*=\s*\[.*agent-response\.sh.*\]/m)) {
			content = content.replace(
				/^notify\s*=\s*\[.*agent-response\.sh.*\]/m,
				`notify = ["${hookPath}"]`,
			);
			writeFileSync(codexConfigFile, content);
		} else {
			// Remove legacy notify and prepend
			content = content.replace(/^notify\s*=\s*\[.*codex-notify\.sh.*\]\s*\n?/m, "");
			writeFileSync(codexConfigFile, `notify = ["${hookPath}"]\n` + content);
		}
	} else {
		writeFileSync(codexConfigFile, `notify = ["${hookPath}"]\n`);
	}

	console.log("salon: Codex CLI notify hook installed");
})();
