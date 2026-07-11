/**
 * Fuente de verdad en memoria de planes activos (Map + status line).
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { currentPlan } from "./plan-guard.js";
import type { PlanState } from "./state.js";
import { clearPlanStatus, setPlanStatus } from "./status.js";

export const activePlans = new Map<string, PlanState>();

export function getActivePlans(): Map<string, PlanState> {
	return activePlans;
}

export function refreshPlanStatus(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	const plan = currentPlan();
	if (plan) setPlanStatus(ctx, plan);
	else clearPlanStatus(ctx);
}

export function clearActivePlans(): void {
	activePlans.clear();
}
