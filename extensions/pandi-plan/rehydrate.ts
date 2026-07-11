/**
 * Rehidratación de plan-mode en session_start.
 * `active-plans.ts` conserva activePlans; este módulo restaura el gate desde JSONL.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { PLAN_STATE_TYPE } from "./persistence.js";
import { restoreActivePlans } from "./registry.js";
import { collectLatestByKey } from "./session-state.js";
import { decodePlanStateSnapshot, persistedPlanStateId } from "./snapshot-parser.js";
import type { PlanState } from "./state.js";

export type RehydrateDeps = {
	getActivePlans: () => Map<string, PlanState>;
	refreshPlanStatus: (ctx: ExtensionContext) => void;
};

let rehydrateDeps: RehydrateDeps | undefined;

export function configureRehydrate(deps: RehydrateDeps): void {
	rehydrateDeps = deps;
}

/**
 * Reconstruye el estado del plan desde entradas persistidas (last-wins por planId). Re-arma el
 * gate de solo lectura para cualquier plan que estuviera aún activo cuando la sesión terminó.
 */
export function rehydrate(ctx: ExtensionContext): void {
	if (!rehydrateDeps) return;
	const activePlans = rehydrateDeps.getActivePlans();
	const entries = ctx.sessionManager.getEntries();
	const latest = collectLatestByKey(entries, PLAN_STATE_TYPE, persistedPlanStateId);
	const validSnapshots: PlanState[] = [];
	for (const value of latest.values()) {
		const state = decodePlanStateSnapshot(value);
		if (state) validSnapshots.push(state);
	}

	restoreActivePlans(activePlans, validSnapshots);
	rehydrateDeps.refreshPlanStatus(ctx);
}
