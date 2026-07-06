/**
 * Handshake de aprobación de `/plan`.
 *
 * Este módulo nombra la frontera entre presentar el plan al humano y decidir si
 * una respuesta todavía aplica al plan/submission actual. No persiste ni muta el
 * lifecycle: `index.ts` conserva esos efectos después de recibir la decisión.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { renderPlanApprovalOverlay } from "./approval-view.js";
import type { PlanState } from "./state.js";

/** ¿La decisión de aprobación corresponde al plan/submission que sigue activo? */
export function isCurrentPlanApproval<T extends Pick<PlanState, "planId" | "submissions">>(
	livePlan: T | undefined,
	expectedPlanId: string,
	expectedSubmission: number,
): livePlan is T {
	return livePlan?.planId === expectedPlanId && livePlan.submissions === expectedSubmission;
}

/** ¿La decisión de aprobación llegó tarde para otro plan o una submission vieja? */
export function isStalePlanApproval<T extends Pick<PlanState, "planId" | "submissions">>(
	livePlan: T | undefined,
	expectedPlanId: string,
	expectedSubmission: number,
): boolean {
	return !isCurrentPlanApproval(livePlan, expectedPlanId, expectedSubmission);
}

/**
 * Presenta el plan para la aprobación explícita del humano y devuelve su decisión.
 *
 * Prefiere el overlay Markdown de estilo mdview cuando la sesión puede mostrar un
 * componente custom; si ese overlay falla o no existe, degrada al diálogo confirm.
 * Un cierre/rechazo del overlay devuelve false: nunca hay aprobación implícita.
 */
export async function presentPlanForApproval(
	ctx: ExtensionContext,
	planText: string,
	planId: string,
): Promise<boolean> {
	if (ctx.hasUI && typeof ctx.ui.custom === "function") {
		try {
			return await renderPlanApprovalOverlay(ctx, planText, planId);
		} catch {
			// Cae al diálogo confirm de abajo — un overlay roto no debe perder la aprobación.
		}
	}
	return await ctx.ui.confirm("Approve this plan?", planText);
}
