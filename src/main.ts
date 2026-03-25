import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { SalonLauncher } from "./runtime.js";
import { TmuxLauncher } from "./tmux-backend.js";

const SCRIPT_DIR = resolve(import.meta.dirname, "..");
const WORK_DIR = process.argv[2] ? resolve(process.argv[2]) : process.cwd();
const SALON_INSTANCE = process.env.SALON_INSTANCE || deriveSalonInstance(WORK_DIR);
const SALON_DIR = process.env.SALON_DIR || join(process.env.HOME!, ".salon", SALON_INSTANCE);
const HOST_SESSION_DIR = join(SALON_DIR, "host-sessions");
const TMUX_SESSION = process.env.SALON_TMUX_SESSION || `salon-${SALON_INSTANCE}`;

type ExistingSessionAction = "kill" | "attach";

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

function prompt(question: string): Promise<string> {
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	return new Promise((resolvePrompt) => {
		rl.question(question, (answer) => {
			rl.close();
			resolvePrompt(answer.trim());
		});
	});
}

async function chooseExistingSessionAction(): Promise<ExistingSessionAction> {
	const answer = (await prompt(`Session '${TMUX_SESSION}' exists. [k]ill / [a]ttach? [a] `)).toLowerCase();
	if (answer === "k" || answer === "kill") return "kill";
	return "attach";
}

function buildEnvironment(): Record<string, string> {
	const vars: Record<string, string> = {};

	for (const key of [
		"http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY", "no_proxy", "NO_PROXY",
		"ANTHROPIC_API_KEY", "OPENAI_API_KEY", "ALL_PROXY", "all_proxy",
	]) {
		if (process.env[key]) vars[key] = process.env[key]!;
	}

	vars.SALON_DIR = SALON_DIR;
	vars.SALON_INSTANCE = SALON_INSTANCE;
	vars.SALON_TMUX_SESSION = TMUX_SESSION;
	vars.SALON_WORK_DIR = WORK_DIR;
	vars.SALON_NODE_BIN = dirname(process.execPath);

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

if (launcher.sessionExists()) {
	const action = await chooseExistingSessionAction();
	if (action === "attach") {
		try {
			launcher.attach();
		} catch {
			// session exited while attaching; just exit.
		}
		process.exit(0);
	}
	launcher.destroySession();
}

launcher.createSession(WORK_DIR);
launcher.setEnvironment(buildEnvironment());

const extensionPath = join(SCRIPT_DIR, "src", "extension.ts");
const piBin = join(SCRIPT_DIR, "node_modules", ".bin", "pi");
const hostCommand = joinShellArgs([piBin, "--extension", extensionPath]);
launcher.launchHost(hostCommand);

// Attach
try {
	launcher.attach();
} catch {
	// session exited
}
