/**
 * Helpers puros para el registro runtime de planes.
 *
 * `index.ts` sigue siendo dueño del Map mutable (`activePlans`) y de los efectos
 * de sesión. Este módulo solo nombra operaciones sobre colecciones de `PlanState`:
 * encontrar el plan activo, rehidratar snapshots activos y combinar histórico +
 * runtime para el dashboard.
 */

import type { PlanState } from "./state.js";

/** Primer plan con gate armado, preservando el orden de iteración del registro. */
export function findActivePlan(plans: Iterable<PlanState>): PlanState | undefined {
	for (const plan of plans) {
		if (plan.active) return plan;
	}
	return undefined;
}

/** ¿Algún plan mantiene armado el gate de solo lectura? */
export function hasActivePlan(plans: Iterable<PlanState>): boolean {
	return findActivePlan(plans) !== undefined;
}

/** Último plan según el orden de iteración del registro; usado como fallback de status. */
export function findLastPlan(plans: Iterable<PlanState>): PlanState | undefined {
	let last: PlanState | undefined;
	for (const plan of plans) last = plan;
	return last;
}

/**
 * Restaura en el registro runtime solo snapshots activos y todavía no presentes.
 * Clona el snapshot para que el runtime pueda mutarlo sin editar la entrada de sesión leída.
 */
export function restoreActivePlans(target: Map<string, PlanState>, snapshots: Iterable<PlanState>): void {
	for (const state of snapshots) {
		if (!state.active) continue;
		if (target.has(state.planId)) continue;
		target.set(state.planId, { ...state });
	}
}

/**
 * Superpone planes runtime sobre el histórico latest-by-planId y devuelve la vista del dashboard.
 *
 * Reproduce la semántica previa de `Map#set`: si un plan ya existía en el histórico,
 * se reemplaza su valor sin moverlo de posición; planes nuevos se agregan al final.
 */
export function overlayRuntimePlans(
	latestByPlanId: Map<string, PlanState>,
	runtimePlans: Iterable<PlanState>,
): PlanState[] {
	for (const plan of runtimePlans) latestByPlanId.set(plan.planId, plan);
	return [...latestByPlanId.values()];
}
