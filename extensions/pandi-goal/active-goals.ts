/**
 * Fuente de verdad en memoria de goals activos (Map + lookup del goal único P0).
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { clearGoalStatus, setGoalStatus } from "./status.js";
import type { ActiveGoal } from "./types.js";

export const activeGoals = new Map<string, ActiveGoal>();

/** Refresca la status line desde el goal activo (pursuing/verifying/verifying-independent). */
export function refreshGoalStatus(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	for (const goal of activeGoals.values()) {
		if (goal.gstatus === "pursuing" || goal.gstatus === "verifying" || goal.gstatus === "verifying-independent") {
			setGoalStatus(ctx, goal);
			return;
		}
	}
	clearGoalStatus(ctx);
}

/** El único goal activo (pursuing, autoverificación o verificación independiente). */
export function activeGoal(): ActiveGoal | undefined {
	return [...activeGoals.values()].find(
		(g) => g.gstatus === "pursuing" || g.gstatus === "verifying" || g.gstatus === "verifying-independent",
	);
}
