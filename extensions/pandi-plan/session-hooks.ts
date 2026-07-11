/**
 * Hooks de sesión para `/plan`.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { clearActivePlans } from "./active-plans.js";
import { resetPlanSessionDefaults } from "./command-handler.js";
import { persist } from "./persistence.js";
import { currentPlan } from "./plan-guard.js";
import { rehydrate } from "./rehydrate.js";
import { clearPlanStatus } from "./status.js";

export function handleSessionStart(event: { reason?: string }, ctx: ExtensionContext): void {
	clearActivePlans();
	resetPlanSessionDefaults();
	if (event.reason === "fork") return;
	rehydrate(ctx);
}

export function handleSessionShutdown(pi: ExtensionAPI, ctx: ExtensionContext): void {
	const plan = currentPlan();
	if (plan) persist(pi, plan);
	clearPlanStatus(ctx);
}
