import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { SalonLauncher } from "./runtime.js";
import { TmuxLauncher } from "./tmux-backend.js";
import { generateSalonInstance } from "./instance.js";

const SCRIPT_DIR = resolve(import.meta.dirname, "..");
const WORK_DIR = process.argv[2] ? resolve(process.argv[2]) : process.cwd();
const SALON_INSTANCE = process.env.SALON_INSTANCE || generateSalonInstance(WORK_DIR);
const SALON_DIR = process.env.SALON_DIR || join(process.env.HOME!, ".salon", SALON_INSTANCE);
const HOST_SESSION_DIR = join(SALON_DIR, "host-sessions");
const TMUX_SESSION = process.env.SALON_TMUX_SESSION || `salon-${SALON_INSTANCE}`;
const AUTONOMOUS_MODE = process.env.SALON_AUTONOMOUS === "1";

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function joinShellArgs(args: string[]): string {
	return args.map(shellQuote).join(" ");
}

function listExistingSalonSessions(): string[] {
	try {
		const output = execFileSync("tmux", ["list-sessions", "-F", "#{session_name}"], {
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		}).trim();
		return output.split("\n").filter(name => name.startsWith("salon-"));
	} catch {
		return [];
	}
}

function buildEnvironment(): Record<string, string> {
	const vars: Record<string, string> = {};
	const pathPrefixes = [dirname(process.execPath)];

	for (const key of [
		"http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY", "no_proxy", "NO_PROXY",
		"ANTHROPIC_API_KEY", "OPENAI_API_KEY", "ALL_PROXY", "all_proxy",
		// Preserve terminal capability hints needed by TUIs for keyboard/image/color support.
		// Intentionally do NOT forward TERM itself here; inside tmux it should remain the
		// tmux-provided value (for example tmux-256color), not the outer terminal's TERM.
		"COLORTERM", "TERM_PROGRAM", "TERM_PROGRAM_VERSION",
		"KITTY_WINDOW_ID", "GHOSTTY_RESOURCES_DIR", "WEZTERM_PANE",
		"ITERM_SESSION_ID", "WT_SESSION", "LC_TERMINAL", "LC_TERMINAL_VERSION",
	]) {
		if (process.env[key]) vars[key] = process.env[key]!;
	}

	vars.SALON_DIR = SALON_DIR;
	vars.SALON_INSTANCE = SALON_INSTANCE;
	vars.SALON_TMUX_SESSION = TMUX_SESSION;
	vars.SALON_WORK_DIR = WORK_DIR;
	if (AUTONOMOUS_MODE) {
		vars.SALON_AUTONOMOUS = "1";
		if (process.env.SALON_CONTAINER_ID) {
			vars.SALON_CONTAINER_ID = process.env.SALON_CONTAINER_ID;
		}
	}
	vars.SALON_NODE_BIN = pathPrefixes.join(":");
	if (process.env.SALON_TASK_FILE) {
		vars.SALON_TASK_FILE = process.env.SALON_TASK_FILE;
	}
	if (process.env.SALON_RESULT_FILE) {
		vars.SALON_RESULT_FILE = process.env.SALON_RESULT_FILE;
	}

	return vars;
}

// ── Main ─────────────────────────────────────────────────────────────

const launcher: SalonLauncher = new TmuxLauncher(TMUX_SESSION);

// Preflight
try {
	launcher.preflight();
} catch {
	console.error("Error: tmux not found.");
	process.exit(1);
}

// Initialize the salon directories; the host session directory must exactly match the session_directory hook in extension.ts.
mkdirSync(join(SALON_DIR, "guests"), { recursive: true });
mkdirSync(HOST_SESSION_DIR, { recursive: true });

const existing = listExistingSalonSessions();
if (existing.length > 0) {
	console.log(`Existing salon sessions (reattach with tmux attach -t <name>):`);
	for (const name of existing) {
		console.log(`  ${name}`);
	}
	console.log("");
}

launcher.createSession(WORK_DIR);
launcher.setEnvironment(buildEnvironment());
if (process.env.SALON_RESULT_FILE) {
	writeFileSync(
		join(dirname(process.env.SALON_RESULT_FILE), "host_pane.txt"),
		`${TMUX_SESSION}:0.0\n`,
	);
}

const extensionPath = join(SCRIPT_DIR, "src", "extension.ts");
const piBin = join(SCRIPT_DIR, "node_modules", ".bin", "pi");
const hostModel = process.env.SALON_HOST_MODEL;
const hostCommand = joinShellArgs([
	piBin,
	"--extension", extensionPath,
	...(hostModel ? ["--model", hostModel] : []),
]);
launcher.launchHost(hostCommand);

if (!AUTONOMOUS_MODE) {
	// Attach
	try {
		launcher.attach();
	} catch {
		// session exited
	}
}
