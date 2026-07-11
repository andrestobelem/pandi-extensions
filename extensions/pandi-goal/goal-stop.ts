/**
 * Parada terminal de un goal: abort, persist y sacar del Map activo.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { activeGoals, refreshGoalStatus } from "./active-goals.js";
import { persist } from "./persistence.js";
import type { GoalStatus } from "./types.js";

export function stopGoal(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	goalId: string,
	reason: string,
	finalStatus: Extract<GoalStatus, "done" | "blocked" | "stopped"> = "stopped",
): boolean {
	const goal = activeGoals.get(goalId);
	if (!goal) return false;
	if (goal.timer) {
		clearTimeout(goal.timer);
		goal.timer = null;
	}
	goal.controller.abort(reason);
	goal.gstatus = finalStatus;
	goal.nextFireAt = null;
	goal.lastReason = reason;
	persist(pi, ctx, goal);
	activeGoals.delete(goalId);
	refreshGoalStatus(ctx);
	return true;
}
