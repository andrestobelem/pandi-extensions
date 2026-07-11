/**
 * Presentación de status para `/goal`: notify (`formatStatus`) y barra TUI
 * (`setGoalStatus` / `clearGoalStatus`).
 *
 * Render puro: sin scheduling, sin ownership de estado. La selección de "qué goal está
 * activo actualmente" queda en engine.ts (refreshGoalStatus), que lee activeGoals y llama
 * estos renderers.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { GOAL_STATUS_KEY } from "./constants.js";
import { formatEta } from "./time.js";
import type { GoalState } from "./types.js";

function formatGoalStatusPhase(goal: GoalState): string {
	return goal.gstatus === "verifying"
		? " verificando"
		: goal.gstatus === "verifying-independent"
			? " verificación⊥"
			: "";
}

function formatGoalStatusEta(goal: GoalState): string {
	return (goal.gstatus === "pursuing" || goal.gstatus === "verifying") && goal.nextFireAt
		? ` próximo ${formatEta(goal.nextFireAt)}`
		: "";
}

function formatGoalStatusReason(goal: GoalState): string {
	return goal.lastReason ? ` · ${goal.lastReason}` : "";
}

function formatGoalStatusIteration(goal: GoalState): string {
	return `it ${goal.iteration}/${goal.maxIterations}`;
}

export function formatStatus(goal: GoalState): string {
	const phase =
		goal.gstatus === "verifying"
			? " (verificando)"
			: goal.gstatus === "verifying-independent"
				? " (verificación independiente)"
				: "";
	const eta =
		goal.gstatus === "pursuing" || goal.gstatus === "verifying" ? `, próximo ${formatEta(goal.nextFireAt)}` : "";
	const reason = goal.lastReason ? `, razón: ${goal.lastReason}` : "";
	return `${goal.goalId} [${goal.gstatus}]${phase} iter ${goal.iteration}/${goal.maxIterations}${eta}${reason} — ${goal.objective}`;
}

export function formatGoalStatusList(goals: GoalState[]): string {
	return goals.map(formatStatus).join("\n");
}

function formatGoalStatusDetails(goal: GoalState): string {
	const iteration = formatGoalStatusIteration(goal);
	const phase = formatGoalStatusPhase(goal);
	const eta = formatGoalStatusEta(goal);
	const reason = formatGoalStatusReason(goal);
	return `${iteration}${phase}${eta}${reason}`;
}

function formatGoalStatusLine(ctx: ExtensionContext, goal: GoalState): string {
	const theme = ctx.ui.theme;
	return `${theme.fg("accent", "◎ /goal")} ${theme.fg("dim", formatGoalStatusDetails(goal))}`;
}

export function setGoalStatus(ctx: ExtensionContext, goal: GoalState): void {
	if (!ctx.hasUI) return;
	ctx.ui.setStatus(GOAL_STATUS_KEY, formatGoalStatusLine(ctx, goal));
}

export function clearGoalStatus(ctx: ExtensionContext): void {
	if (ctx.hasUI) ctx.ui.setStatus(GOAL_STATUS_KEY, undefined);
}
