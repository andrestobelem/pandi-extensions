/**
 * Persistence helpers for the `/goal` extension, factored into a sibling so index.ts
 * keeps only the engine/wiring. These are PARAMETERIZED (they take pi/ctx/goal/state as
 * arguments) and close over no module-mutable state, so they move cleanly. Behavior is
 * unchanged: identical JSONL append via pi.appendEntry + atomic sidecar write (temp file
 * then rename), same swallow-on-error semantics.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	CONFIG_DIR_NAME,
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { GOAL_DIR, GOAL_STATE_TYPE, PROGRESS_LOG_KEEP, STATE_FILE } from "./constants.js";
import type { ActiveGoal, GoalState } from "./types.js";

export function snapshot(goal: ActiveGoal): GoalState {
	return {
		goalId: goal.goalId,
		objective: goal.objective,
		successCriteria: goal.successCriteria,
		derivedCriteria: goal.derivedCriteria,
		ultracode: goal.ultracode,
		iteration: goal.iteration,
		maxIterations: goal.maxIterations,
		contextPercentCap: goal.contextPercentCap,
		// Bound the persisted log so the JSONL entry never grows without limit.
		assessments: goal.assessments.slice(-PROGRESS_LOG_KEEP),
		verifyAttempts: goal.verifyAttempts,
		independentVerifyAttempts: goal.independentVerifyAttempts,
		maxIndependentVerifications: goal.maxIndependentVerifications,
		verifierTimeoutMs: goal.verifierTimeoutMs,
		verifierTools: goal.verifierTools,
		gstatus: goal.gstatus,
		startedAt: goal.startedAt,
		nextFireAt: goal.nextFireAt,
		lastReason: goal.lastReason,
		updatedAt: goal.updatedAt,
	};
}

/**
 * Persist a goal transition. Stamps `updatedAt`, appends to the session JSONL (does NOT
 * go to the LLM), and fire-and-forgets an ATOMIC sidecar write for crash recovery.
 */
export function persist(pi: ExtensionAPI, ctx: ExtensionContext, goal: ActiveGoal): void {
	goal.updatedAt = new Date().toISOString();
	const snap = snapshot(goal);
	pi.appendEntry<GoalState>(GOAL_STATE_TYPE, snap);
	void writeSidecar(ctx, snap).catch(() => {});
}

/**
 * Dual-root state dir:
 * - trusted project → <cwd>/.pi/goals/<id>
 * - otherwise       → <agentDir>/goals/<projectHash>/<id>
 */
function goalStateDir(ctx: ExtensionContext, goalId: string): string {
	if (ctx.isProjectTrusted()) return path.join(ctx.cwd, CONFIG_DIR_NAME, GOAL_DIR, goalId);
	const projectHash = crypto.createHash("sha1").update(ctx.cwd).digest("hex").slice(0, 12);
	return path.join(getAgentDir(), GOAL_DIR, projectHash, goalId);
}

/** Atomic write: temp file then rename, so a crash mid-write never truncates state.json. */
async function writeSidecar(ctx: ExtensionContext, state: GoalState): Promise<void> {
	const dir = goalStateDir(ctx, state.goalId);
	await fs.mkdir(dir, { recursive: true });
	const file = path.join(dir, STATE_FILE);
	const temp = `${file}.${crypto.randomBytes(6).toString("hex")}.tmp`;
	await fs.writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
	try {
		await fs.rename(temp, file);
	} catch (err) {
		await fs.rm(temp, { force: true }).catch(() => {});
		throw err;
	}
}
