/**
 * Guard global de modo plan y helpers de plan activo en memoria.
 * `index.ts` conserva el Map vivo; este módulo consulta vía deps inyectadas.
 */

import { findActivePlan, hasActivePlan } from "./registry.js";
import type { PlanState } from "./state.js";

export interface PlanModeGuard {
	isActive(): boolean;
}

export const PLAN_MODE_GUARD_SYMBOL = Symbol.for("pandi-plan.plan-mode.guard");

export type PlanGuardDeps = {
	getActivePlans: () => Map<string, PlanState>;
};

let guardDeps: PlanGuardDeps | undefined;

/** Registra el Map de planes activos (active-plans.ts). */
export function configurePlanGuard(deps: PlanGuardDeps): void {
	guardDeps = deps;
}

function activePlanValues(): Iterable<PlanState> {
	return guardDeps?.getActivePlans().values() ?? [];
}

/** ¿Está el gate de solo lectura armado (algún plan actualmente activo)? */
export function planModeActive(): boolean {
	return hasActivePlan(activePlanValues());
}

export function isPlanModeActive(): boolean {
	return planModeActive();
}

/** El único plan actualmente activo (gate armado), o undefined. */
export function currentPlan(): PlanState | undefined {
	return findActivePlan(activePlanValues());
}

const previousPlanModeGuard = (globalThis as Record<symbol, PlanModeGuard | undefined>)[PLAN_MODE_GUARD_SYMBOL];
export const PLAN_MODE_GUARD: PlanModeGuard = {
	isActive: () => {
		if (isPlanModeActive()) return true;
		try {
			return previousPlanModeGuard?.isActive() === true;
		} catch {
			return false;
		}
	},
};
(globalThis as Record<symbol, PlanModeGuard | undefined>)[PLAN_MODE_GUARD_SYMBOL] = PLAN_MODE_GUARD;
