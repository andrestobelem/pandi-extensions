/**
 * Presentación de status-line para la extensión `/goal`.
 *
 * Render puro del estado de un único goal en la status line de Pi: sin scheduling, sin
 * ownership de estado, sin I/O fuera de ctx.ui. La selección de "qué goal está activo
 * actualmente" queda en index.ts (refreshGoalStatus), que lee el map activeGoals y llama
 * a estos renderers.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { GOAL_STATUS_KEY } from "./constants.js";
import { formatEta } from "./time.js";
import type { GoalState } from "./types.js";

export function setGoalStatus(ctx: ExtensionContext, goal: GoalState): void {
	if (!ctx.hasUI) return;
	const theme = ctx.ui.theme;
	const phase =
		goal.gstatus === "verifying" ? " verifying" : goal.gstatus === "verifying-independent" ? " verifying⊥" : "";
	const eta =
		(goal.gstatus === "pursuing" || goal.gstatus === "verifying") && goal.nextFireAt
			? ` next ${formatEta(goal.nextFireAt)}`
			: "";
	const reason = goal.lastReason ? ` · ${goal.lastReason}` : "";
	ctx.ui.setStatus(
		GOAL_STATUS_KEY,
		`${theme.fg("accent", "◎ goal")} ${theme.fg("dim", `it ${goal.iteration}/${goal.maxIterations}${phase}${eta}${reason}`)}`,
	);
}

export function clearGoalStatus(ctx: ExtensionContext): void {
	if (ctx.hasUI) ctx.ui.setStatus(GOAL_STATUS_KEY, undefined);
}
