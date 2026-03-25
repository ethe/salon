/**
 * GuestRuntime — abstract interface for guest agent execution environments.
 *
 * The extension orchestration logic programs against this interface.
 * Concrete backends (e.g. TmuxBackend) implement the actual mechanics.
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
