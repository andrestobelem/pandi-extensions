/**
 * Protocolo de aprobación de `/plan`.
 *
 * Este módulo nombra la frontera entre presentarle el plan al humano y decidir si
 * una respuesta todavía aplica al plan/envío actual. No persiste ni muta el
 * ciclo de vida: `index.ts` conserva esos efectos después de recibir la decisión.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { renderPlanApprovalOverlay } from "./approval-view.js";
import type { PlanState } from "./state.js";

export interface PlanApprovalOptions {
	/** Si true, no elegir antes del timeout equivale a aprobar el plan. */
	autoSubmit?: boolean;
	/** Timeout de auto-submit en milisegundos; producción usa 60_000. */
	timeoutMs?: number;
}

function normalizeTimeoutMs(timeoutMs: number | undefined): number {
	return typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.floor(timeoutMs) : 60_000;
}

async function confirmPlanForApproval(
	ctx: ExtensionContext,
	planText: string,
	options: PlanApprovalOptions,
): Promise<boolean> {
	if (!options.autoSubmit) return await ctx.ui.confirm("¿Aprobar este plan?", planText);

	const timeoutMs = normalizeTimeoutMs(options.timeoutMs);
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const seconds = Math.ceil(timeoutMs / 1000);
		const approved = await ctx.ui.confirm(`¿Aprobar este plan? (auto-submit en ${seconds}s)`, planText, {
			signal: controller.signal,
		});
		if (approved) return true;
		return controller.signal.aborted;
	} catch (error) {
		if (controller.signal.aborted) return true;
		throw error;
	} finally {
		clearTimeout(timeout);
	}
}

/** ¿La decisión de aprobación corresponde al plan/envío que sigue activo? */
export function isCurrentPlanApproval<T extends Pick<PlanState, "planId" | "submissions">>(
	livePlan: T | undefined,
	expectedPlanId: string,
	expectedSubmission: number,
): livePlan is T {
	return livePlan?.planId === expectedPlanId && livePlan.submissions === expectedSubmission;
}

/** ¿La decisión de aprobación llegó tarde para otro plan o para un envío viejo? */
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
 * componente personalizado; si ese overlay falla o no existe, degrada al diálogo confirm.
 * Un cierre/rechazo del overlay devuelve false. Con auto-submit opt-in, solo el timeout
 * configurado aprueba automáticamente.
 */
export async function presentPlanForApproval(
	ctx: ExtensionContext,
	planText: string,
	planId: string,
	options: PlanApprovalOptions = {},
): Promise<boolean> {
	if (ctx.hasUI && typeof ctx.ui.custom === "function") {
		try {
			return await renderPlanApprovalOverlay(ctx, planText, planId, options);
		} catch {
			// Cae al diálogo confirm de abajo — un overlay roto no debe perder la aprobación.
		}
	}
	return await confirmPlanForApproval(ctx, planText, options);
}
