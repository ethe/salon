/**
 * Discussion engine — pure state machine for multi-guest discussions.
 *
 * All functions mutate the Discussion in place and return commands
 * for the caller to dispatch. No I/O happens here.
 */

// ── Types ────────────────────────────────────────────────────────────

export type DiscussionStage = "exploring" | "debating" | "synthesizing" | "done";

export interface DiscussionRound {
	responses: Map<string, string>;
}

export interface Discussion {
	id: string;
	topic: string;
	guestA: string;
	guestB: string;
	stage: DiscussionStage;
	rounds: DiscussionRound[];
	currentRound: DiscussionRound;
}

export interface PersistedDiscussionRound {
	responses: Record<string, string>;
}

export interface PersistedDiscussion {
	id: string;
	topic: string;
	guestA: string;
	guestB: string;
	stage: DiscussionStage;
	rounds: PersistedDiscussionRound[];
	currentRound: PersistedDiscussionRound;
}

// ── Commands ─────────────────────────────────────────────────────────

export type DiscussionCommand =
	| { type: "sendToGuest"; guestName: string; message: string; from?: string }
	| { type: "notifyHost"; message: string }
	| { type: "persist" };

// ── Serialization ────────────────────────────────────────────────────

export function serializeDiscussionRound(round: DiscussionRound): PersistedDiscussionRound {
	return { responses: Object.fromEntries(round.responses) };
}

export function deserializeDiscussionRound(round: PersistedDiscussionRound | undefined): DiscussionRound {
	return { responses: new Map(Object.entries(round?.responses || {})) };
}

export function serializeDiscussion(disc: Discussion): PersistedDiscussion {
	return {
		id: disc.id,
		topic: disc.topic,
		guestA: disc.guestA,
		guestB: disc.guestB,
		stage: disc.stage,
		rounds: disc.rounds.map(serializeDiscussionRound),
		currentRound: serializeDiscussionRound(disc.currentRound),
	};
}

export function deserializeDiscussion(disc: PersistedDiscussion): Discussion {
	return {
		id: disc.id,
		topic: disc.topic,
		guestA: disc.guestA,
		guestB: disc.guestB,
		stage: disc.stage,
		rounds: (disc.rounds || []).map(deserializeDiscussionRound),
		currentRound: deserializeDiscussionRound(disc.currentRound),
	};
}

// ── Pure state transitions ───────────────────────────────────────────

export function handleMessage(
	disc: Discussion,
	from: string,
	content: string,
): { handled: boolean; commands: DiscussionCommand[] } {
	disc.currentRound.responses.set(from, content);

	if (!disc.currentRound.responses.has(disc.guestA) || !disc.currentRound.responses.has(disc.guestB)) {
		const other = from === disc.guestA ? disc.guestB : disc.guestA;
		return {
			handled: true,
			commands: [
				{ type: "notifyHost", message: `[salon] "${disc.topic}" — ${from} has responded, waiting for ${other}.` },
			],
		};
	}

	const responseA = disc.currentRound.responses.get(disc.guestA)!;
	const responseB = disc.currentRound.responses.get(disc.guestB)!;
	disc.rounds.push(disc.currentRound);
	const roundNum = disc.rounds.length;

	if (disc.stage === "exploring") {
		disc.stage = "debating";
		disc.currentRound = { responses: new Map() };
		return {
			handled: true,
			commands: [
				{ type: "notifyHost", message: `[salon] "${disc.topic}" — both guests have given initial proposals (round ${roundNum}). Cross-review starting.` },
				{ type: "sendToGuest", guestName: disc.guestA, message: responseB, from: disc.guestB },
				{ type: "sendToGuest", guestName: disc.guestB, message: responseA, from: disc.guestA },
				{ type: "persist" },
			],
		};
	}

	if (disc.stage === "debating") {
		disc.currentRound = { responses: new Map() };
		return {
			handled: true,
			commands: [
				{
					type: "notifyHost",
					message:
						`[salon] "${disc.topic}" — round ${roundNum} complete.\n\n` +
						`[${disc.guestA}]: ${responseA}\n\n` +
						`[${disc.guestB}]: ${responseB}\n\n` +
						`Review both responses. Use advance_discussion to decide: "continue" (another debate round), "synthesize" (move to synthesis), or "ask_user" (escalate open questions to the user).`,
				},
				{ type: "persist" },
			],
		};
	}

	if (disc.stage === "synthesizing") {
		disc.currentRound = { responses: new Map() };
		return {
			handled: true,
			commands: [
				{
					type: "notifyHost",
					message:
						`[salon] "${disc.topic}" — guests have reviewed your synthesis.\n\n` +
						`[${disc.guestA}]: ${responseA}\n\n` +
						`[${disc.guestB}]: ${responseB}\n\n` +
						`If both guests approve, use finalize_discussion to complete. Otherwise revise and submit_synthesis again.`,
				},
				{ type: "persist" },
			],
		};
	}

	return { handled: false, commands: [] };
}

export type AdvanceAction = "continue" | "synthesize" | "ask_user";

export function advance(
	disc: Discussion,
	action: AdvanceAction,
	message?: string,
): { commands: DiscussionCommand[] } {
	if (action === "continue") {
		const lastRound = disc.rounds[disc.rounds.length - 1];
		const lastA = lastRound?.responses.get(disc.guestA) || "";
		const lastB = lastRound?.responses.get(disc.guestB) || "";
		const commands: DiscussionCommand[] = [];
		if (message) {
			commands.push({ type: "sendToGuest", guestName: disc.guestA, message: `${message}\n\n${lastB}`, from: disc.guestB });
			commands.push({ type: "sendToGuest", guestName: disc.guestB, message: `${message}\n\n${lastA}`, from: disc.guestA });
		} else {
			commands.push({ type: "sendToGuest", guestName: disc.guestA, message: lastB, from: disc.guestB });
			commands.push({ type: "sendToGuest", guestName: disc.guestB, message: lastA, from: disc.guestA });
		}
		return { commands };
	}

	if (action === "synthesize") {
		disc.stage = "synthesizing";
		return { commands: [{ type: "persist" }] };
	}

	if (action === "ask_user") {
		disc.stage = "done";
		return { commands: [{ type: "persist" }] };
	}

	throw new Error(`Unknown action: ${action}`);
}

export function submitSynthesisToGuests(
	disc: Discussion,
	synthesis: string,
): { commands: DiscussionCommand[] } {
	const reviewPrompt =
		`The host has synthesized the discussion on "${disc.topic}". ` +
		`Please review this synthesis. If you agree it's accurate and complete, say so. ` +
		`If you have objections or corrections, state them clearly.\n\n${synthesis}`;
	return {
		commands: [
			{ type: "sendToGuest", guestName: disc.guestA, message: reviewPrompt },
			{ type: "sendToGuest", guestName: disc.guestB, message: reviewPrompt },
		],
	};
}

export function finalize(disc: Discussion): { commands: DiscussionCommand[] } {
	disc.stage = "done";
	return { commands: [{ type: "persist" }] };
}

export function buildSummary(disc: Discussion): string {
	const parts: string[] = [];
	for (let i = 0; i < disc.rounds.length; i++) {
		const round = disc.rounds[i];
		const label = i === 0 ? "Initial proposals" : `Round ${i + 1}`;
		parts.push(`── ${label} ──`);
		const a = round.responses.get(disc.guestA);
		const b = round.responses.get(disc.guestB);
		if (a) parts.push(`[${disc.guestA}]: ${a}`);
		if (b) parts.push(`[${disc.guestB}]: ${b}`);
		parts.push("");
	}
	return parts.join("\n");
}
