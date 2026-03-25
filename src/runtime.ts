/**
 * Runtime abstractions for salon.
 *
 * - SalonLauncher: session-level bootstrap (create, attach, env, host launch)
 * - GuestRuntime: guest-level operations (spawn, send, status, focus)
 *
 * Concrete backends (e.g. TmuxLauncher, TmuxBackend) implement these.
 */

export type GuestStatus = "starting" | "working" | "input" | "idle" | "new";

export interface RuntimeSpawnOptions {
	name: string;
	guestType: "claude" | "codex";
	workDir: string;
	command: string;
	salonDir: string;
	initialSessionId?: string;
}

export interface GuestRuntime {
	/** Create a new guest runtime, launch the command inside it. Returns the runtime id. */
	spawn(options: RuntimeSpawnOptions): string;

	/** Send text to a guest runtime (backend decides how to submit). */
	send(runtimeId: string, text: string): void;

	/** Interrupt a guest (e.g. Ctrl-C). */
	interrupt(runtimeId: string): void;

	/** Terminate a guest (e.g. send "exit" command). */
	terminate(runtimeId: string): void;

	/** Detect the guest's display status by inspecting its output. */
	getStatus(runtimeId: string): GuestStatus;

	/** Check whether a runtime is still alive. */
	isAlive(runtimeId: string): boolean;

	/** Switch focus to a guest runtime. */
	focus(runtimeId: string): void;

	/** Equalize layout across all guest runtimes. */
	equalize(): void;

	/** Destroy the entire runtime session (e.g. kill tmux session). */
	destroySession(): void;

	/** List all live runtime IDs. */
	listAlive(): string[];

	/** Adopt an existing runtime (e.g. after session restore). Backend configures transport based on guestType. */
	adopt(runtimeId: string, guestType: "claude" | "codex"): void;
}

// ── Session-level bootstrap ──────────────────────────────────────────

export interface SalonLauncher {
	/** Check that the runtime backend is available (e.g. tmux is installed). Throws if not. */
	preflight(): void;

	/** Check whether a session already exists. */
	sessionExists(): boolean;

	/** Create a new session and configure it. */
	createSession(workDir: string): void;

	/** Destroy an existing session. */
	destroySession(): void;

	/** Attach to the session (blocks until detach). */
	attach(): void;

	/** Inject environment variables into the session. */
	setEnvironment(vars: Record<string, string>): void;

	/** Launch the host agent in the session's primary pane. */
	launchHost(command: string): void;
}
