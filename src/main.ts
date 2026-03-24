import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { createInterface } from "node:readline";

const SCRIPT_DIR = resolve(import.meta.dirname, "..");
const WORK_DIR = process.argv[2] ? resolve(process.argv[2]) : process.cwd();
const SALON_INSTANCE = process.env.SALON_INSTANCE || deriveSalonInstance(WORK_DIR);
const SALON_DIR = process.env.SALON_DIR || join("/tmp", "salon", SALON_INSTANCE);
const HOST_SESSION_DIR = join(SALON_DIR, "host-sessions");
const TMUX_SESSION = process.env.SALON_TMUX_SESSION || `salon-${SALON_INSTANCE}`;
const HOST_PANE = `${TMUX_SESSION}:0.0`;
const SALON_WORKSPACE_MODE = process.env.SALON_WORKSPACE_MODE || "auto";

type LaunchMode = "fresh" | "resume";
type ExistingSessionAction = "kill" | "resume" | "attach";

function deriveSalonInstance(workDir: string): string {
	const base = basename(workDir) || "workspace";
	const slug = base
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "") || "workspace";
	const hash = createHash("sha1").update(workDir).digest("hex").slice(0, 8);
	return `${slug}-${hash}`;
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function joinShellArgs(args: string[]): string {
	return args.map(shellQuote).join(" ");
}

function tmux(args: string[]): string {
	try {
		return execFileSync("tmux", args, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
	} catch {
		return "";
	}
}

function tmuxSessionExists(): boolean {
	try {
		execFileSync("tmux", ["has-session", "-t", TMUX_SESSION], { stdio: "pipe" });
		return true;
	} catch {
		return false;
	}
}

function prompt(question: string): Promise<string> {
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	return new Promise((resolvePrompt) => {
		rl.question(question, (answer) => {
			rl.close();
			resolvePrompt(answer.trim());
		});
	});
}

function tmuxSendLine(target: string, line: string) {
	tmux(["send-keys", "-t", target, "-l", line]);
	tmux(["send-keys", "-t", target, "Enter"]);
}

function hasSavedHostSessions(): boolean {
	if (!existsSync(HOST_SESSION_DIR)) return false;
	return readdirSync(HOST_SESSION_DIR).some((file) => file.endsWith(".jsonl"));
}

async function chooseExistingSessionAction(): Promise<ExistingSessionAction> {
	const answer = (await prompt(`Session '${TMUX_SESSION}' exists. [k]ill / [r]esume / [a]ttach? [a] `)).toLowerCase();
	if (answer === "k" || answer === "kill") return "kill";
	if (answer === "r" || answer === "resume") return "resume";
	return "attach";
}

async function chooseLaunchMode(): Promise<LaunchMode> {
	if (!hasSavedHostSessions()) return "fresh";
	const answer = (await prompt(`Found previous host sessions in '${HOST_SESSION_DIR}'. Resume? [Y/n] `)).toLowerCase();
	if (answer === "n" || answer === "no") return "fresh";
	return "resume";
}

function configureTmuxSession() {
	tmux(["set-option", "-t", TMUX_SESSION, "-g", "mouse", "on"]);
	tmux(["set-option", "-t", TMUX_SESSION, "-g", "extended-keys", "on"]);
	tmux(["set-option", "-t", TMUX_SESSION, "-g", "extended-keys-format", "csi-u"]);
	tmux(["rename-window", "-t", `${TMUX_SESSION}:0`, "salon"]);
}

function ensureTmuxSession() {
	if (!tmuxSessionExists()) {
		tmux(["new-session", "-d", "-s", TMUX_SESSION, "-x", "200", "-y", "50", "-c", WORK_DIR]);
	}
	configureTmuxSession();
}

function forwardEnvironmentToHostPane() {
	const envForward = [
		"http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY", "no_proxy", "NO_PROXY",
		"ANTHROPIC_API_KEY", "OPENAI_API_KEY", "ALL_PROXY", "all_proxy",
	]
		.filter((key) => process.env[key])
		.map((key) => `export ${key}=${shellQuote(process.env[key]!)}`);

	envForward.push(`export SALON_DIR=${shellQuote(SALON_DIR)}`);
	envForward.push(`export SALON_INSTANCE=${shellQuote(SALON_INSTANCE)}`);
	envForward.push(`export SALON_TMUX_SESSION=${shellQuote(TMUX_SESSION)}`);
	envForward.push(`export SALON_WORK_DIR=${shellQuote(WORK_DIR)}`);
	envForward.push(`export SALON_WORKSPACE_MODE=${shellQuote(SALON_WORKSPACE_MODE)}`);
	if (envForward.length > 0) {
		tmuxSendLine(HOST_PANE, envForward.join("; "));
	}
}

function writeHostLauncherScript(mode: LaunchMode): string {
	const extensionPath = join(SCRIPT_DIR, "src", "extension.ts");
	const launcherPath = join(SALON_DIR, "host-launch.sh");
	const command = mode === "resume"
		? joinShellArgs(["pi", "--continue", "--extension", extensionPath])
		: joinShellArgs(["pi", "--extension", extensionPath]);
	writeFileSync(launcherPath, [
		"#!/usr/bin/env bash",
		"set -euo pipefail",
		`cd ${shellQuote(WORK_DIR)}`,
		`exec ${command}`,
	].join("\n"));
	chmodSync(launcherPath, 0o755);
	return launcherPath;
}

function launchHost(mode: LaunchMode, reuseExistingTmux: boolean) {
	if (reuseExistingTmux) {
		// When reusing an existing tmux session, interrupt the old host first to avoid two pi instances sharing the main pane.
		tmux(["send-keys", "-t", HOST_PANE, "C-c"]);
		tmux(["send-keys", "-t", HOST_PANE, "C-c"]);
		tmuxSendLine(HOST_PANE, "clear");
	}

	forwardEnvironmentToHostPane();
	const launcherPath = writeHostLauncherScript(mode);
	tmuxSendLine(HOST_PANE, `exec bash ${shellQuote(launcherPath)}`);
}

// Preflight
try {
	execFileSync("tmux", ["-V"], { stdio: "pipe" });
} catch {
	console.error("Error: tmux not found.");
	process.exit(1);
}

// Initialize the salon directories; the host session directory must exactly match the session_directory hook in extension.ts.
mkdirSync(join(SALON_DIR, "guests"), { recursive: true });
mkdirSync(HOST_SESSION_DIR, { recursive: true });

// Install hooks (idempotent) — unified hook for both Claude Code and Codex CLI
const hookPath = join(SCRIPT_DIR, "hooks", "agent-response.sh");

// Claude Code: Stop hook in ~/.claude/settings.json
(() => {
	const settingsDir = join(process.env.HOME!, ".claude");
	const settingsFile = join(settingsDir, "settings.json");
	mkdirSync(settingsDir, { recursive: true });
	const hookEntry = { matcher: "", hooks: [{ type: "command", command: hookPath }] };
	if (existsSync(settingsFile)) {
		const settings = JSON.parse(readFileSync(settingsFile, "utf-8"));
		const stopHooks: Array<{ hooks?: Array<{ command?: string }> }> = settings.hooks?.Stop || [];
		if (stopHooks.some((entry) => entry.hooks?.some((hook: { command?: string }) => hook.command?.includes("agent-response.sh")))) {
			return;
		}
		// Remove legacy hooks to avoid duplicate stop events.
		if (settings.hooks?.Stop) {
			for (const entry of settings.hooks.Stop) {
				entry.hooks = entry.hooks?.filter((hook: { command?: string }) =>
					!hook.command?.includes("claude-stop.sh") && !hook.command?.includes("planner-stop.sh"));
			}
		}
		settings.hooks = settings.hooks || {};
		settings.hooks.Stop = settings.hooks.Stop || [];
		settings.hooks.Stop.push(hookEntry);
		writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
	} else {
		writeFileSync(settingsFile, JSON.stringify({ hooks: { Stop: [hookEntry] } }, null, 2));
	}
})();

// Codex CLI: notify in ~/.codex/config.toml
(() => {
	const codexConfigDir = join(process.env.HOME!, ".codex");
	const codexConfigFile = join(codexConfigDir, "config.toml");
	mkdirSync(codexConfigDir, { recursive: true });
	if (existsSync(codexConfigFile)) {
		let content = readFileSync(codexConfigFile, "utf-8");
		if (content.includes("agent-response.sh")) return;
		content = content.replace(/^notify\s*=\s*\[.*codex-notify\.sh.*\]\s*\n?/m, "");
		writeFileSync(codexConfigFile, `notify = [\"${hookPath}\"]\n` + content);
	} else {
		writeFileSync(codexConfigFile, `notify = [\"${hookPath}\"]\n`);
	}
})();

let launchMode: LaunchMode;
let reuseExistingTmux = false;

if (tmuxSessionExists()) {
	const action = await chooseExistingSessionAction();
	if (action === "attach") {
		try {
			execFileSync("tmux", ["attach", "-t", TMUX_SESSION], { stdio: "inherit" });
		} catch {
			// tmux exited while attaching; just exit.
		}
		process.exit(0);
	}

	if (action === "resume") {
		reuseExistingTmux = true;
		launchMode = hasSavedHostSessions() ? "resume" : "fresh";
		if (launchMode === "fresh") {
			console.log(`No saved host session found in '${HOST_SESSION_DIR}'. Starting fresh host in existing tmux session.`);
		}
	} else {
		tmux(["kill-session", "-t", TMUX_SESSION]);
		launchMode = await chooseLaunchMode();
	}
} else {
	launchMode = await chooseLaunchMode();
}

ensureTmuxSession();
launchHost(launchMode, reuseExistingTmux);

// Attach
try {
	execFileSync("tmux", ["attach", "-t", TMUX_SESSION], { stdio: "inherit" });
} catch {
	// tmux exited
}
