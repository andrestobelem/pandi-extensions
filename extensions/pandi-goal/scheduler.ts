/**
 * Scheduler de `/goal`: wakes, timers y transiciones pursuing/verifying.
 * El Map activo vive en active-goals.ts; el scheduler importa stopGoal desde goal-stop.ts.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { MAX_WAIT_SECONDS, MIN_WAIT_SECONDS } from "./constants.js";
import { stopGoal } from "./goal-stop.js";
import { notify } from "./notify.js";
import { persist } from "./persistence.js";
import { makeGoalIterationPrompt, makeGoalVerificationPrompt } from "./prompts.js";
import { setGoalStatus } from "./status.js";
import type { ActiveGoal, GoalAssessment } from "./types.js";

/**
 * Un goal solo puede correr donde el loop del agente es lo bastante interactivo para
 * reinyectar un prompt y retomar por su cuenta: TUI y RPC. "print" es de una sola
 * ejecución, "json" es no interactivo; ninguno puede sostener un goal.
 */
export function canGoalInMode(ctx: ExtensionContext): boolean {
	return ctx.mode === "tui" || ctx.mode === "rpc";
}

export function normalizeWaitSeconds(raw: unknown): number {
	if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return 0;
	return Math.min(MAX_WAIT_SECONDS, Math.max(MIN_WAIT_SECONDS, Math.round(raw)));
}

function wake(pi: ExtensionAPI, ctx: ExtensionContext, prompt: string): void {
	// Compuerta de modo: nunca reinyectar fuera de tui/rpc (también defiende rutas de rehydrate).
	if (!canGoalInMode(ctx)) return;
	if (ctx.isIdle()) pi.sendUserMessage(prompt);
	else pi.sendUserMessage(prompt, { deliverAs: "followUp" });
}

/**
 * Compuerta de mejor esfuerzo de presupuesto de contexto. Devuelve un texto de razón
 * de parada si el porcentaje de uso de contexto supera el tope; si no, undefined. `percent`
 * puede ser null justo después de compactación (según types.d.ts), y en ese caso NO corta.
 */
export function contextBudgetExceeded(ctx: ExtensionContext, goal: ActiveGoal): string | undefined {
	const usage = ctx.getContextUsage?.();
	if (usage && usage.percent !== null && usage.percent >= goal.contextPercentCap) {
		return `presupuesto de contexto agotado (${Math.round(usage.percent)}% ≥ ${goal.contextPercentCap}%)`;
	}
	return undefined;
}

/**
 * Dispara una iteración. Protege el estado, aplica maxIterations + presupuesto de
 * contexto y después reinyecta el prompt adecuado para la fase actual (iteración vs
 * verificación).
 */
export function fireGoal(pi: ExtensionAPI, ctx: ExtensionContext, goal: ActiveGoal): void {
	goal.timer = null;
	if (goal.gstatus !== "pursuing" && goal.gstatus !== "verifying") return;

	if (goal.iteration >= goal.maxIterations) {
		stopGoal(pi, ctx, goal.goalId, `alcanzó el límite de maxIterations (${goal.maxIterations})`, "stopped");
		notify(
			ctx,
			`Goal ${goal.goalId} detenido: alcanzó el límite de maxIterations (${goal.maxIterations}).`,
			"warning",
		);
		return;
	}

	// Compuerta de mejor esfuerzo de presupuesto antes de hacer cualquier trabajo.
	const budget = contextBudgetExceeded(ctx, goal);
	if (budget) {
		stopGoal(pi, ctx, goal.goalId, budget, "stopped");
		notify(ctx, `Goal ${goal.goalId} detenido: ${budget}. Podés hacer /compact y retomar.`, "warning");
		return;
	}

	goal.iteration += 1;
	goal.nextFireAt = null;
	goal.rearmedThisTurn = false;
	persist(pi, ctx, goal);
	setGoalStatus(ctx, goal);
	const prompt = goal.gstatus === "verifying" ? makeGoalVerificationPrompt(goal) : makeGoalIterationPrompt(goal);
	try {
		wake(pi, ctx, prompt);
	} catch (err) {
		stopGoal(pi, ctx, goal.goalId, `falló la entrega del wake: ${(err as Error).message}`, "stopped");
		notify(ctx, `Goal ${goal.goalId} detenido: falló la entrega del wake.`, "error");
	}
}

/**
 * Arma el próximo wake después de delaySec (0 = inmediato vía setTimeout(…, 0)). El
 * llamador es responsable de clampear. Lo usan advanceGoal y la transición de verificación.
 */
export function scheduleGoal(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	goal: ActiveGoal,
	delaySec: number,
	reason: string,
): void {
	if (goal.timer) {
		clearTimeout(goal.timer);
		goal.timer = null;
	}
	goal.nextFireAt = delaySec > 0 ? Date.now() + delaySec * 1000 : null;
	goal.lastReason = reason;
	goal.rearmedThisTurn = true;
	persist(pi, ctx, goal);
	setGoalStatus(ctx, goal);
	goal.timer = setTimeout(() => fireGoal(pi, ctx, goal), Math.max(0, delaySec * 1000));
}

/**
 * Registra una autoevaluación y arma la próxima iteración `pursuing`. `continue`
 * mantiene el goal en `pursuing`; una verificación fallida (`continue` desde
 * `verifying`) también vuelve a `pursuing`. La cadencia es inmediata (delay 0) salvo
 * que se haya dado waitSeconds (clampeado).
 */
export function advanceGoal(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	goal: ActiveGoal,
	assessment: GoalAssessment,
	delaySec: number,
	reason: string,
): void {
	goal.assessments.push(assessment);
	goal.gstatus = "pursuing";
	scheduleGoal(pi, ctx, goal, delaySec, reason);
}
