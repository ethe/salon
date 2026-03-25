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

console.log("\n== 10. Guest termination uses correct exit commands ==");
{
	const backend = new TmuxBackend(TMUX_SESSION);

	tmux(`new-session -d -s "${TMUX_SESSION}" -x 100 -y 30`);
	tmux(`send-keys -t "${TMUX_SESSION}:0" "cat" Enter`);
	await sleep(500);
	const claudePane = tmux(`display-message -p -t "${TMUX_SESSION}:0" "#{pane_id}"`);
	backend.terminate(claudePane, "claude");
	await sleep(300);
	const claudeOutput = tmux(`capture-pane -t "${TMUX_SESSION}:0" -p`);
	assert("Claude terminate sends /exit", claudeOutput.includes("/exit"));
	tmux(`kill-session -t "${TMUX_SESSION}"`);

	tmux(`new-session -d -s "${TMUX_SESSION}" -x 100 -y 30`);
	tmux(`send-keys -t "${TMUX_SESSION}:0" "cat" Enter`);
	await sleep(500);
	const codexPane = tmux(`display-message -p -t "${TMUX_SESSION}:0" "#{pane_id}"`);
	backend.terminate(codexPane, "codex");
	await sleep(300);
	const codexOutput = tmux(`capture-pane -t "${TMUX_SESSION}:0" -p`);
	assert("Codex terminate sends exit", codexOutput.includes("exit"));
	assert("Codex terminate does not send /exit", !codexOutput.includes("/exit"));
	tmux(`kill-session -t "${TMUX_SESSION}"`);
}

console.log("\n== 11. Environment variable forwarding ==");
{
	const envVars = ["http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY", "no_proxy",
		"NO_PROXY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "ALL_PROXY", "all_proxy"];

	for (const v of ["http_proxy", "ANTHROPIC_API_KEY"]) {
		assert(`${v} in forward list`, envVars.includes(v));
	}
}

console.log("\n== 12. Guest wrapper emits ready and exit lifecycle events ==");
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

console.log("\n== 13. Resume summary formatting ==");
{
	const summary = extensionTest.formatRecoveredSalonSummary({
		salonInstance: "test-instance",
		workDir: "/repo",
		activeGuests: [{ name: "alice", type: "claude", runtimeId: "%1", workspaceDir: "/repo", sessionId: "s1", ready: true }],
		suspendedGuests: [{ name: "bob", type: "codex", workspaceDir: "/repo", sessionId: "s2" }],
		dismissedGuests: [{ name: "carol", type: "claude", workspaceDir: "/repo", sessionId: "s3" }],
		resumeFailures: [{ name: "dave", reason: "tmux pane creation failed" }],
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
	assert("Summary includes resume failure", summary?.includes("dave: tmux pane creation failed") === true);
}


console.log("\n== 14. Wrapper ready watcher sends guest_ready via socket ==");
{
	// Spawn a shell that prints a prompt containing ❯, simulating a real guest TUI.
	// The wrapper's background ready-watcher should detect this and send guest_ready.
	tmux(`kill-session -t "${TMUX_SESSION}"`);
	tmux(`new-session -d -s "${TMUX_SESSION}" -x 100 -y 30`);
	// The wrapper script requires SALON_NODE_BIN (set -u).
	tmux(`set-environment -t "${TMUX_SESSION}" SALON_NODE_BIN "/usr/bin"`);

	const { messages, close } = startTestServer();
	await sleep(200);

	const backend = new TmuxBackend(TMUX_SESSION);
	// The "guest" command just prints a prompt-like string and waits.
	// Use a script that prints ❯ and then sleeps so the pane stays alive.
	const guestCommand = `printf '❯ ' && sleep 30`;
	const runtimeId = backend.spawn({
		name: "ready-watcher-test",
		guestType: "claude",
		workDir: "/tmp",
		command: guestCommand,
		salonDir: SALON_DIR,
		initialSessionId: "test-session-rw",
	});
	assert("Wrapper pane spawned", runtimeId.startsWith("%"));

	// Wait for the ready watcher to detect the prompt and send the event.
	// The watcher polls every 0.5s after the command starts; give it time.
	await sleep(8000);

	const readyMsgs = messages.filter(
		(m) => m.from === "_system" && m.content === "guest_ready:ready-watcher-test",
	);
	assert("guest_ready event received via socket", readyMsgs.length === 1);

	close();
	tmux(`kill-session -t "${TMUX_SESSION}"`);
}

console.log("\n== 15. sayToGuest queues when guest not ready, sends when ready ==");
{
	// Test the real sayToGuestImpl: when guest.ready=false, message enters
	// queuedGuestMessages; when guest.ready=true, runtime.send() is called.
	const { sayToGuestImpl, queuedGuestMessages } = extensionTest;
	const sentMessages: Array<{ runtimeId: string; text: string }> = [];
	const fakeRuntime = {
		send(runtimeId: string, text: string) { sentMessages.push({ runtimeId, text }); },
	} as any;
	const fakeCtx = {
		runtime: fakeRuntime,
		salonDir: SALON_DIR,
		getMsgFileCounter: () => 0,
		incMsgFileCounter: () => 1,
		msgLengthThreshold: 2000,
	};

	// Clean state
	queuedGuestMessages.clear();

	// Guest not ready → queued
	const guest = {
		name: "queue-test", type: "claude" as const, runtimeId: "%fake",
		ready: false, startedAt: Date.now(), lifecycleStatus: "active" as const,
		workspaceDir: "/tmp",
	};
	const status1 = sayToGuestImpl(fakeCtx, guest, "hello world");
	assert("sayToGuest returns 'queued' when not ready", status1 === "queued");
	assert("No runtime.send() call when queued", sentMessages.length === 0);
	const queued = queuedGuestMessages.get("queue-test");
	assert("Message is in queuedGuestMessages", queued?.length === 1);
	assert("Queued message content correct", queued?.[0]?.message === "hello world");
	assert("Queued message from defaults to host", queued?.[0]?.from === "host");

	// Guest ready → sent
	guest.ready = true;
	const status2 = sayToGuestImpl(fakeCtx, guest, "second message", "reviewer");
	assert("sayToGuest returns 'sent' when ready", status2 === "sent");
	assert("runtime.send() called once", sentMessages.length === 1);
	assert("runtime.send() receives prefixed message", sentMessages[0].text === "[reviewer]: second message");
	assert("runtime.send() targets correct pane", sentMessages[0].runtimeId === "%fake");

	queuedGuestMessages.clear();
}

console.log("\n== 16. flushQueuedGuestMessages delivers queued messages via runtime ==");
{
	// Test the real flush path: queue two messages while not ready, flip ready,
	// call flush, verify runtime.send() receives both in order.
	const { sayToGuestImpl, flushQueuedGuestMessagesImpl, queuedGuestMessages } = extensionTest;
	const sentMessages: Array<{ runtimeId: string; text: string }> = [];
	const fakeRuntime = {
		send(runtimeId: string, text: string) { sentMessages.push({ runtimeId, text }); },
	} as any;
	const fakeCtx = {
		runtime: fakeRuntime,
		salonDir: SALON_DIR,
		getMsgFileCounter: () => 0,
		incMsgFileCounter: () => 1,
		msgLengthThreshold: 2000,
	};

	queuedGuestMessages.clear();

	const guest = {
		name: "flush-test", type: "claude" as const, runtimeId: "%fake2",
		ready: false, startedAt: Date.now(), lifecycleStatus: "active" as const,
		workspaceDir: "/tmp",
	};

	// Queue two messages while not ready
	sayToGuestImpl(fakeCtx, guest, "first task");
	sayToGuestImpl(fakeCtx, guest, "second task", "other-guest");
	assert("Two messages queued", queuedGuestMessages.get("flush-test")?.length === 2);
	assert("No sends yet", sentMessages.length === 0);

	// Simulate guest_ready: flip ready, then flush
	guest.ready = true;
	flushQueuedGuestMessagesImpl(fakeCtx, guest);

	assert("Queue cleared after flush", !queuedGuestMessages.has("flush-test"));
	assert("Two messages sent via runtime", sentMessages.length === 2);
	assert("First message delivered with host prefix", sentMessages[0].text === "[host]: first task");
	assert("Second message delivered with custom prefix", sentMessages[1].text === "[other-guest]: second task");
	assert("Both target correct pane", sentMessages.every((m) => m.runtimeId === "%fake2"));

	queuedGuestMessages.clear();
}

console.log("\n== 17. invite_guest + sayToGuest(initial_message) → queue → flush → deliver ==");
{
	// Full extension-layer test of the invite_guest(initial_message) path:
	// 1. inviteGuest() creates a guest with ready=false
	// 2. sayToGuestImpl() queues the initial_message
	// 3. Simulating guest_ready: flip ready + flushQueuedGuestMessagesImpl()
	// 4. Verify runtime.send() receives the correct prefixed message
	const { inviteGuest, sayToGuestImpl, flushQueuedGuestMessagesImpl, guests, queuedGuestMessages } = extensionTest;
	const sentMessages: Array<{ runtimeId: string; text: string }> = [];
	const fakeRuntime = {
		spawn() { return "%fake-invite"; },
		send(runtimeId: string, text: string) { sentMessages.push({ runtimeId, text }); },
		equalize() {},
	} as any;
	const fakeCtx = {
		runtime: fakeRuntime,
		salonDir: SALON_DIR,
		getMsgFileCounter: () => 0,
		incMsgFileCounter: () => 1,
		msgLengthThreshold: 2000,
	};

	// Clean state
	guests.clear();
	queuedGuestMessages.clear();

	// Step 1: inviteGuest creates guest with ready=false
	const guest = inviteGuest("invite-test", "claude", "/tmp", SALON_DIR, GUEST_DIR, fakeRuntime);
	assert("Guest created with ready=false", guest.ready === false);
	assert("Guest registered in guests map", guests.has("invite-test"));

	// Step 2: sayToGuest queues the initial_message (mimics invite_guest execute)
	const status = sayToGuestImpl(fakeCtx, guest, "please review the code");
	assert("initial_message returns 'queued'", status === "queued");
	assert("No runtime.send() before ready", sentMessages.length === 0);
	assert("Message queued in queuedGuestMessages", queuedGuestMessages.get("invite-test")?.length === 1);

	// Step 3: Simulate guest_ready event → flip ready + flush
	guest.ready = true;
	flushQueuedGuestMessagesImpl(fakeCtx, guest);

	// Step 4: Verify runtime received the message
	assert("runtime.send() called after flush", sentMessages.length === 1);
	assert("Message has [host]: prefix", sentMessages[0].text === "[host]: please review the code");
	assert("Queue empty after flush", !queuedGuestMessages.has("invite-test"));

	// Cleanup module-level state
	guests.delete("invite-test");
	queuedGuestMessages.clear();
}

// ══════════════════════════════════════════════════════════════════════
cleanup();

console.log(`\n${"─".repeat(40)}`);
console.log(`${passed} passed, ${failed} failed`);

process.exit(failed > 0 ? 1 : 0);
