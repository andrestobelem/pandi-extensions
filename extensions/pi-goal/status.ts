/**
 * Status-line presentation for the `/goal` extension.
 *
 * Pure rendering of a single goal's status into Pi's status line: no scheduling, no state
 * ownership, no I/O beyond ctx.ui. The "which goal is currently active" selection stays in
 * index.ts (refreshGoalStatus), which reads the activeGoals map and calls these renderers.
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
