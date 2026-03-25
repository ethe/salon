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

// Claude Code: Stop hook in ~/.claude/settings.json
(() => {
	const settingsDir = join(process.env.HOME!, ".claude");
	const settingsFile = join(settingsDir, "settings.json");
	mkdirSync(settingsDir, { recursive: true });

	const makeEntry = () => ({ matcher: "", hooks: [{ type: "command", command: hookPath }] });

	if (existsSync(settingsFile)) {
		const settings = JSON.parse(readFileSync(settingsFile, "utf-8"));
		const stopHooks: Array<{ hooks?: Array<{ type?: string; command?: string }> }> = settings.hooks?.Stop || [];

		// Check if already up-to-date
		if (stopHooks.some((e) => e.hooks?.some((h) => h.command === hookPath))) return;

		// Replace stale entry if present, otherwise append
		let replaced = false;
		for (const entry of stopHooks) {
			if (!entry.hooks) continue;
			for (let i = 0; i < entry.hooks.length; i++) {
				if (entry.hooks[i].command?.includes("agent-response.sh")) {
					entry.hooks[i] = { type: "command", command: hookPath };
					replaced = true;
				}
			}
		}

		// Remove legacy hooks
		for (const entry of stopHooks) {
			if (!entry.hooks) continue;
			entry.hooks = entry.hooks.filter((h) =>
				!h.command?.includes("claude-stop.sh") && !h.command?.includes("planner-stop.sh"));
		}

		if (!replaced) {
			settings.hooks = settings.hooks || {};
			settings.hooks.Stop = settings.hooks.Stop || [];
			settings.hooks.Stop.push(makeEntry());
		}

		writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
	} else {
		writeFileSync(settingsFile, JSON.stringify({ hooks: { Stop: [makeEntry()] } }, null, 2));
	}

	console.log("salon: Claude Code Stop hook installed");
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
