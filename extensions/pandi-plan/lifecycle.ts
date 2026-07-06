/**
 * Transiciones del ciclo de vida de un plan.
 *
 * Estas funciones nombran las mutaciones pequeñas que ya existían inline en el
 * runtime (`index.ts`). No persisten, no notifican y no tocan UI: solo actualizan
 * el snapshot `PlanState` que el llamador luego persiste/refresca.
 */

import type { PlanState } from "./state.js";

/** Registra un nuevo plan enviado por `submit_plan` y devuelve su número de envío. */
export function recordPlanSubmission(plan: PlanState, planText: string): number {
	plan.lastPlan = planText;
	plan.submissions += 1;
	return plan.submissions;
}

/** Marca el resultado plan-only/no-interactivo: hay plan, pero el gate sigue armado. */
export function markPlanOnlyRecorded(plan: PlanState): void {
	plan.status = "planned";
}

/** Marca aprobación humana: levanta el gate y permite pasar a implementación. */
export function markPlanApproved(plan: PlanState): void {
	plan.active = false;
	plan.status = "approved";
}

/** Marca rechazo humano: sigue planificando y cuenta la revisión pedida. */
export function markPlanRejected(plan: PlanState): void {
	plan.rejections += 1;
	plan.status = "planning";
}

/** Sale del modo plan sin implementar. */
export function markPlanExited(plan: PlanState): void {
	plan.active = false;
	plan.status = "exited";
}
