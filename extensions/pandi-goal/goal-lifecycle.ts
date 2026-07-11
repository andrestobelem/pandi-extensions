/**
 * Ciclo de vida de `/goal`: inicio, resolución y rehidratación.
 * El Map activo vive en active-goals.ts; la verificación P1 en verification.ts.
 */

import * as crypto from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { activeGoal, activeGoals, refreshGoalStatus } from "./active-goals.js";
import { parseGoalArgs } from "./command-intent.js";
import {
	DEFAULT_CONTEXT_PERCENT_CAP,
	DEFAULT_MAX_INDEPENDENT_VERIFICATIONS,
	DEFAULT_MAX_ITERATIONS,
	DEFAULT_VERIFIER_TIMEOUT_MS,
	DEFAULT_VERIFIER_TOOLS,
	GOAL_STATE_TYPE,
} from "./constants.js";
import { notify } from "./notify.js";
import { persist } from "./persistence.js";
import { canGoalInMode, fireGoal } from "./scheduler.js";
import { collectLatestByKey } from "./session-state.js";
import type { ActiveGoal, GoalState, GoalStatus } from "./types.js";
import { beginIndependentVerification } from "./verification.js";

export { activeGoal, activeGoals } from "./active-goals.js";
export { stopGoal } from "./goal-stop.js";

export function startGoal(pi: ExtensionAPI, ctx: ExtensionContext, args: string): ActiveGoal | undefined {
	if (!canGoalInMode(ctx)) {
		notify(ctx, "/goal requiere una sesión TUI o RPC (este modo no puede sostener un goal).", "error");
		return undefined;
	}
	const existing = activeGoal();
	if (existing) {
		notify(
			ctx,
			`Ya hay un goal activo (${existing.goalId}: ${existing.objective}). Detenélo primero con /goal stop.`,
			"warning",
		);
		return undefined;
	}
	const { objective, successCriteria, ultracode } = parseGoalArgs(args);
	if (!objective) {
		notify(ctx, "Uso: /goal [--ultracode] <objective> [-- <success criteria>]", "warning");
		return undefined;
	}

	const goalId = crypto.randomBytes(4).toString("hex");
	const goal: ActiveGoal = {
		goalId,
		objective,
		successCriteria,
		derivedCriteria: undefined,
		ultracode,
		iteration: 0,
		maxIterations: DEFAULT_MAX_ITERATIONS,
		contextPercentCap: DEFAULT_CONTEXT_PERCENT_CAP,
		assessments: [],
		verifyAttempts: 0,
		independentVerifyAttempts: 0,
		maxIndependentVerifications: DEFAULT_MAX_INDEPENDENT_VERIFICATIONS,
		verifierTimeoutMs: DEFAULT_VERIFIER_TIMEOUT_MS,
		verifierTools: [...DEFAULT_VERIFIER_TOOLS],
		gstatus: "pursuing",
		startedAt: Date.now(),
		nextFireAt: null,
		lastReason: undefined,
		updatedAt: new Date().toISOString(),
		timer: null,
		controller: new AbortController(),
		rearmedThisTurn: false,
		verifierInFlight: false,
	};

	activeGoals.set(goalId, goal);
	persist(pi, ctx, goal);

	fireGoal(pi, ctx, goal);
	const crit = successCriteria ? " (con criterios)" : " (el modelo va a derivar los criterios)";
	const uc = ultracode ? " [ultracode]" : "";
	notify(ctx, `Goal ${goalId} iniciado${crit}${uc}: ${objective}`, "info");
	return goal;
}

export async function resolveGoal(
	ctx: ExtensionContext,
	idOrUndef: string | undefined,
	statuses: GoalStatus[] = ["pursuing", "verifying", "verifying-independent"],
): Promise<ActiveGoal | undefined> {
	if (idOrUndef) return activeGoals.get(idOrUndef);
	const candidates = [...activeGoals.values()].filter((g) => statuses.includes(g.gstatus));
	if (candidates.length === 0) return undefined;
	if (candidates.length === 1) return candidates[0];
	if (ctx.hasUI) {
		const choice = await ctx.ui.select(
			"¿Qué goal?",
			candidates.map((g) => `${g.goalId} — ${g.objective}`),
		);
		if (!choice) return undefined;
		const id = choice.split(" ")[0];
		return activeGoals.get(id);
	}
	return undefined;
}

export function rehydrate(pi: ExtensionAPI, ctx: ExtensionContext): void {
	if (!canGoalInMode(ctx)) return;
	const entries = ctx.sessionManager.getEntries();
	const latest = collectLatestByKey<GoalState>(entries, GOAL_STATE_TYPE, (d) => d.goalId);

	for (const state of latest.values()) {
		if (
			state.gstatus !== "pursuing" &&
			state.gstatus !== "verifying" &&
			state.gstatus !== "verifying-independent" &&
			state.gstatus !== "stale"
		) {
			continue;
		}
		if (activeGoals.has(state.goalId)) continue;

		const goal: ActiveGoal = {
			...state,
			gstatus: state.gstatus === "stale" ? "pursuing" : state.gstatus,
			assessments: Array.isArray(state.assessments) ? state.assessments : [],
			verifyAttempts: typeof state.verifyAttempts === "number" ? state.verifyAttempts : 0,
			independentVerifyAttempts:
				typeof state.independentVerifyAttempts === "number" ? state.independentVerifyAttempts : 0,
			maxIndependentVerifications:
				typeof state.maxIndependentVerifications === "number"
					? state.maxIndependentVerifications
					: DEFAULT_MAX_INDEPENDENT_VERIFICATIONS,
			verifierTimeoutMs:
				typeof state.verifierTimeoutMs === "number" ? state.verifierTimeoutMs : DEFAULT_VERIFIER_TIMEOUT_MS,
			verifierTools: Array.isArray(state.verifierTools) ? state.verifierTools : [...DEFAULT_VERIFIER_TOOLS],
			timer: null,
			controller: new AbortController(),
			rearmedThisTurn: false,
			verifierInFlight: false,
		};
		activeGoals.set(goal.goalId, goal);

		if (goal.gstatus === "verifying-independent") {
			void beginIndependentVerification(pi, ctx, goal);
			continue;
		}

		const remaining = goal.nextFireAt === null ? 0 : Math.max(0, goal.nextFireAt - Date.now());
		goal.timer = setTimeout(() => fireGoal(pi, ctx, goal), remaining);
	}
	refreshGoalStatus(ctx);
}
