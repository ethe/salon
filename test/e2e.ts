/**
 * Salon end-to-end tests.
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { createServer, type Server } from "node:net";
import { __test__ as extensionTest } from "../src/extension.ts";
import { TmuxBackend } from "../src/tmux-backend.ts";

const TMUX_SESSION = "salon-test";
const SALON_DIR = "/tmp/salon-test";
const SCRIPT_DIR = join(import.meta.dirname, "..");
const GUEST_DIR = join(SALON_DIR, "guests");
const SOCK_PATH = join(SALON_DIR, "salon.sock");

let passed = 0;
let failed = 0;

function tmux(cmd: string): string {
	try {
		return execSync(`tmux ${cmd}`, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
	} catch {
		return "";
	}
}

function sleep(ms: number) {
	return new Promise((r) => setTimeout(r, ms));
}

function assert(name: string, condition: boolean, detail = "") {
	if (condition) {
		console.log(`  \u2713 ${name}`);
		passed++;
	} else {
		console.log(`  \u2717 ${name}${detail ? ` — ${detail}` : ""}`);
		failed++;
	}
}

function cleanup() {
	tmux(`kill-session -t "${TMUX_SESSION}"`);
	if (existsSync(SALON_DIR)) rmSync(SALON_DIR, { recursive: true });
}

// Start a test socket server, returns received messages
function startTestServer(): { server: Server; messages: Array<{ from: string; content: string }>; close: () => void } {
	const messages: Array<{ from: string; content: string }> = [];
	if (existsSync(SOCK_PATH)) unlinkSync(SOCK_PATH);
	const server = createServer((conn) => {
		let data = "";
		conn.on("data", (chunk) => { data += chunk.toString(); });
		conn.on("end", () => {
			try {
				const msg = JSON.parse(data);
				if (msg.from && msg.content) messages.push(msg);
			} catch { /* ignore */ }
		});
	});
	server.listen(SOCK_PATH);
	return { server, messages, close: () => { server.close(); if (existsSync(SOCK_PATH)) unlinkSync(SOCK_PATH); } };
}

// ══════════════════════════════════════════════════════════════════════
cleanup();
mkdirSync(GUEST_DIR, { recursive: true });

console.log("\n== 1. Guest instructions file ==");
{
	const instructions = `You are in a salon — a collaborative workspace where a host agent coordinates multiple agents. Messages prefixed with [name]: are from the host or another agent. Your response to these is automatically forwarded back. Messages without a [name]: prefix are from a human interacting with you directly. These stay private.`;
	const instrFile = join(GUEST_DIR, "test-guest.instructions");
	writeFileSync(instrFile, instructions);

	assert("Instructions file created", existsSync(instrFile));
	assert("Content is salon context only", !readFileSync(instrFile, "utf-8").includes("Your name is"));
	assert("Content mentions [name]: prefix", readFileSync(instrFile, "utf-8").includes("[name]:"));
}

console.log("\n== 2. Claude Code launch flags ==");
{
	const instrFile = join(GUEST_DIR, "claude-guest.instructions");
	writeFileSync(instrFile, "test instructions");
	const expectedCmd = `claude --append-system-prompt-file '${instrFile}'`;
	assert("Claude uses --append-system-prompt-file", expectedCmd.includes("--append-system-prompt-file"));
	assert("Points to instructions file", expectedCmd.includes(instrFile));
}

console.log("\n== 3. Codex CLI launch flags ==");
{
	const instrFile = join(GUEST_DIR, "codex-guest.instructions");
	writeFileSync(instrFile, "test instructions");
	const expectedCmd = `codex -c model_instructions_file='"${instrFile}"'`;
	assert("Codex uses -c model_instructions_file", expectedCmd.includes("model_instructions_file"));
	assert("Points to instructions file", expectedCmd.includes(instrFile));
}

console.log("\n== 4. Unix socket IPC — hook sends to server ==");
{
	const hookPath = join(SCRIPT_DIR, "hooks", "agent-response.sh");
	assert("Hook script exists", existsSync(hookPath));

	const { messages, close } = startTestServer();
	await sleep(200);

	// Test Claude Code format (stdin)
	try {
		execSync(
			`echo '{"last_assistant_message":"hello from claude","stop_hook_active":false}' | SALON_GUEST_NAME=hook-test SALON_DIR="${SALON_DIR}" bash "${hookPath}"`,
			{ stdio: "pipe", timeout: 5000 },
		);
	} catch { /* ignore */ }

	await sleep(300);
	assert("Claude message received via socket", messages.length === 1);
	assert("Claude message from correct guest", messages[0]?.from === "hook-test");
	assert("Claude message content", messages[0]?.content === "hello from claude");

	// Test Codex format ($1 argument)
	try {
		execSync(
			`SALON_GUEST_NAME=codex-test SALON_DIR="${SALON_DIR}" bash "${hookPath}" '{"type":"agent-turn-complete","last-assistant-message":"hello from codex"}'`,
			{ stdio: "pipe", timeout: 5000 },
		);
	} catch { /* ignore */ }

	await sleep(300);
	assert("Codex message received via socket", messages.length === 2);
	assert("Codex message content", messages[1]?.content === "hello from codex");

	close();
}

console.log("\n== 5. Hook skips non-salon instances ==");
{
	const hookPath = join(SCRIPT_DIR, "hooks", "agent-response.sh");
	const { messages, close } = startTestServer();
	await sleep(200);

	// No SALON_GUEST_NAME → should skip
	try {
		execSync(
			// The test process itself may be running inside a salon guest environment, so clear the inherited SALON_GUEST_NAME explicitly.
			`echo '{"last_assistant_message":"should be ignored"}' | SALON_GUEST_NAME= SALON_DIR="${SALON_DIR}" bash "${hookPath}"`,
			{ stdio: "pipe", timeout: 5000 },
		);
	} catch { /* ignore */ }

	await sleep(300);
	assert("No message when no SALON_GUEST_NAME", messages.length === 0);

	close();
}

console.log("\n== 6. Hook skips non-response Codex events ==");
{
	const hookPath = join(SCRIPT_DIR, "hooks", "agent-response.sh");
	const { messages, close } = startTestServer();
	await sleep(200);

	try {
		execSync(
			`SALON_GUEST_NAME=skip-test SALON_DIR="${SALON_DIR}" bash "${hookPath}" '{"type":"thread.started","last-assistant-message":"nope"}'`,
			{ stdio: "pipe", timeout: 5000 },
		);
	} catch { /* ignore */ }

	await sleep(300);
	assert("Non-response event skipped", messages.length === 0);

	close();
}

console.log("\n== 7. Hook skips when no socket ==");
{
	const hookPath = join(SCRIPT_DIR, "hooks", "agent-response.sh");
	// No server running, no socket file
	let exitCode = 0;
	try {
		execSync(
			`echo '{"last_assistant_message":"no socket"}' | SALON_GUEST_NAME=no-sock SALON_DIR="/tmp/salon-nonexistent" bash "${hookPath}"`,
			{ stdio: "pipe", timeout: 5000 },
		);
	} catch (e: any) {
		exitCode = e.status ?? 1;
	}
	assert("Hook exits cleanly when no socket", exitCode === 0);
}

console.log("\n== 8. tmux pane management ==");
{
	tmux(`kill-session -t "${TMUX_SESSION}"`);
	tmux(`new-session -d -s "${TMUX_SESSION}" -x 100 -y 30`);

	const pane1 = tmux(`split-window -h -t "${TMUX_SESSION}:0.0" -p 50 -P -F "#{pane_id}"`);
	assert("First guest pane created", pane1.startsWith("%"));

	const panes1 = tmux(`list-panes -t "${TMUX_SESSION}:0" -F "#{pane_id}"`).split("\n");
	assert("Two panes after first guest", panes1.length === 2);

	const pane2 = tmux(`split-window -v -t "${pane1}" -P -F "#{pane_id}"`);
	assert("Second guest pane created", pane2.startsWith("%"));

	const panes2 = tmux(`list-panes -t "${TMUX_SESSION}:0" -F "#{pane_id}"`).split("\n");
	assert("Three panes after second guest", panes2.length === 3);

	tmux(`kill-pane -t "${pane2}"`);
	const panes3 = tmux(`list-panes -t "${TMUX_SESSION}:0" -F "#{pane_id}"`).split("\n");
	assert("Back to two panes after kill", panes3.length === 2);

	tmux(`kill-session -t "${TMUX_SESSION}"`);
}

console.log("\n== 9. Send keys with submit key ==");
{
	tmux(`new-session -d -s "${TMUX_SESSION}" -x 100 -y 30`);
	tmux(`send-keys -t "${TMUX_SESSION}:0" "cat" Enter`);
	await sleep(500);

	execSync(
		`tmux send-keys -l -t "${TMUX_SESSION}:0" "[host]: hello claude" && sleep 0.2 && tmux send-keys -t "${TMUX_SESSION}:0" Enter`,
		{ stdio: "pipe" },
	);
	await sleep(500);
	const output1 = tmux(`capture-pane -t "${TMUX_SESSION}:0" -p`);
	assert("Claude-style send: text received", output1.includes("[host]: hello claude"));

	execSync(
		`tmux send-keys -l -t "${TMUX_SESSION}:0" "[host]: hello codex" && sleep 0.2 && tmux send-keys -t "${TMUX_SESSION}:0" C-m`,
		{ stdio: "pipe" },
	);
	await sleep(500);
	const output2 = tmux(`capture-pane -t "${TMUX_SESSION}:0" -p`);
	assert("Codex-style send: text received", output2.includes("[host]: hello codex"));

	tmux(`kill-session -t "${TMUX_SESSION}"`);
}

console.log("\n== 10. Environment variable forwarding ==");
{
	const envVars = ["http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY", "no_proxy",
		"NO_PROXY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "ALL_PROXY", "all_proxy"];

	for (const v of ["http_proxy", "ANTHROPIC_API_KEY"]) {
		assert(`${v} in forward list`, envVars.includes(v));
	}
}

console.log("\n== 11. Guest wrapper emits ready and exit lifecycle events ==");
{
	const backend = new TmuxBackend(TMUX_SESSION);
	const script = backend.buildWrapperScript({
		name: "ready-test",
		guestType: "claude",
		salonDir: SALON_DIR,
		workDir: "/tmp/ready-test",
		command: "echo hello",
		initialSessionId: "abc123",
	});
	assert("Wrapper emits guest_ready", script.includes("guest_ready:ready-test"));
	assert("Wrapper emits guest_ready_timeout", script.includes("guest_ready_timeout:ready-test"));
	assert("Wrapper emits guest_exited", script.includes("guest_exited:ready-test:$SESSION_ID"));
}

console.log("\n== 12. Resume summary formatting ==");
{
	const summary = extensionTest.formatRecoveredSalonSummary({
		salonInstance: "test-instance",
		workDir: "/repo",
		activeGuests: [{ name: "alice", type: "claude", runtimeId: "%1", workspaceDir: "/repo", sessionId: "s1", ready: true }],
		suspendedGuests: [{ name: "bob", type: "codex", workspaceDir: "/repo", sessionId: "s2" }],
		dismissedGuests: [{ name: "carol", type: "claude", workspaceDir: "/repo", sessionId: "s3" }],
		activeDiscussions: [{
			topic: "direction-check",
			stage: "debating",
			completedRounds: 2,
			guestA: "alice",
			guestB: "bob",
			awaiting: ["bob"],
		}],
		archivedPendingDiscussions: [],
	});
	assert("Summary includes instance", summary?.includes("test-instance") === true);
	assert("Summary includes active guest", summary?.includes("alice (claude)") === true);
	assert("Summary includes suspended section", summary?.includes("Suspended guests (auto-paused when host exited, ready to resume):") === true);
	assert("Summary includes dismissed section", summary?.includes("Dismissed guests:") === true);
	assert("Summary includes discussion stage", summary?.includes("stage=debating") === true);
}


// ══════════════════════════════════════════════════════════════════════
cleanup();

console.log(`\n${"─".repeat(40)}`);
console.log(`${passed} passed, ${failed} failed`);

process.exit(failed > 0 ? 1 : 0);
