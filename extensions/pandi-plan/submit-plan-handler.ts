/**
 * Handler execute de la tool submit_plan.
 *
 * Extraído de index.ts para achicar el punto de entrada: el registro del tool
 * queda en index; acá vive el cuerpo del handshake de aprobación / plan-only.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isCurrentPlanApproval, presentPlanForApproval } from "./approval-handshake.js";
import { markPlanApproved, markPlanOnlyRecorded, markPlanRejected, recordPlanSubmission } from "./lifecycle.js";
import { notify } from "./notify.js";
import { writeAndOpenPlanHtmlArtifact } from "./plan-html.js";
import { makeImplementPrompt } from "./prompts.js";
import type { PlanState } from "./state.js";
import { setPlanStatus } from "./status.js";

export type SubmitPlanDeps = {
	pi: ExtensionAPI;
	currentPlan: () => PlanState | undefined;
	persist: (pi: ExtensionAPI, plan: PlanState) => void;
	refreshPlanStatus: (ctx: ExtensionContext) => void;
	wake: (pi: ExtensionAPI, ctx: ExtensionContext, prompt: string) => void;
};

export type SubmitPlanParams = {
	plan: string;
};

/** Details union que registerTool infiere desde todas las ramas del execute original. */
export type SubmitPlanDetails = {
	isError?: boolean;
	planId?: string;
	status?: string;
	approved?: boolean;
	reason?: string;
	rejections?: number;
};

type SubmitPlanResult = {
	content: Array<{ type: "text"; text: string }>;
	details: SubmitPlanDetails;
};

/**
 * Factory del execute de submit_plan. Cierra sobre deps de index (pi, plan activo,
 * persist/wake/status) sin tocar el gate ni el guard global.
 */
export function createSubmitPlanExecute(deps: SubmitPlanDeps) {
	const { pi, currentPlan, persist, refreshPlanStatus, wake } = deps;

	return async (
		_toolCallId: string,
		params: SubmitPlanParams,
		_signal: AbortSignal | undefined,
		_onUpdate: unknown,
		ctx: ExtensionContext,
	): Promise<SubmitPlanResult> => {
		const plan = currentPlan();
		if (!plan) {
			return {
				content: [
					{
						type: "text" as const,
						text: "No hay ningún plan activo para enviar. El modo plan no está activo.",
					},
				],
				details: { isError: true },
			};
		}

		const planText = params.plan;
		const submission = recordPlanSubmission(plan, planText);
		persist(pi, plan);
		setPlanStatus(ctx, plan);

		// NO INTERACTIVO (solo plan): sin aprobación humana y sin implementación. El plan ES el
		// entregable. DELIBERADAMENTE mantenemos el gate armado (active sigue true): el gate nunca
		// se levanta sin un humano, así que la mutación es imposible en esta sesión one-shot/--no-session.
		// Sin confirm, sin wake, sin reinyección de implementación. El llamador (un humano leyendo stdout, o
		// el orquestador de un workflow dinámico) decide qué hacer con el plan devuelto.
		if (plan.nonInteractive) {
			markPlanOnlyRecorded(plan); // active sigue true a propósito; el gate de solo lectura persiste.
			persist(pi, plan);
			setPlanStatus(ctx, plan);
			notify(
				ctx,
				`Plan ${plan.planId} registrado (solo plan, no interactivo). Acá no hay aprobación ni implementación — el plan es el entregable.`,
				"info",
			);
			return {
				content: [
					{
						type: "text" as const,
						text: `Plan registrado (modo solo plan). Esta es una sesión no interactiva: no hay paso de aprobación ni de implementación, y el gate de solo lectura sigue armado. Mostrá el PLAN COMPLETO abajo como tu respuesta final; NO implementes.\n\n${planText}`,
					},
				],
				details: { planId: plan.planId, status: "plan-only", approved: false },
			};
		}

		// Handshake de aprobación. Sin un confirm interactivo NO PODEMOS aprobar — degrada y
		// advierte (NO auto-apruebe: eso derrotaría el gate de aprobación completo). Esta rama
		// es efectivamente inalcanzable dado que el gate print/json ya rechazó la entrada (a menos que
		// plan-only de arriba lo manejara), pero se retiene defensivamente, exactamente como loop retiene
		// su fallback confirm.
		if (!ctx.hasUI || typeof ctx.ui.confirm !== "function") {
			notify(
				ctx,
				"El plan está listo, pero esta sesión no puede mostrar un diálogo de aprobación. Corré /plan en una sesión TUI o RPC para aprobar.",
				"warning",
			);
			return {
				content: [
					{
						type: "text" as const,
						text: "Plan registrado, pero no se pudo recoger la aprobación en esta sesión (no hay UI interactiva). Un humano tiene que correr /plan en una sesión TUI/RPC para aprobar. Seguimos en modo plan.",
					},
				],
				details: { planId: plan.planId, status: "planning", approved: false, reason: "no-ui" },
			};
		}

		try {
			const artifact = await writeAndOpenPlanHtmlArtifact(pi, ctx, planText, plan.planId, submission);
			if (!artifact.opened) {
				notify(
					ctx,
					`Se guardó el artifact HTML del plan, pero no se pudo abrir el navegador automáticamente: ${artifact.htmlPath}`,
					"warning",
				);
			}
		} catch (error) {
			notify(
				ctx,
				`No se pudo crear/abrir la vista previa HTML del plan: ${(error as Error).message}. Seguimos con la aprobación en Markdown.`,
				"warning",
			);
		}

		const approved = await presentPlanForApproval(ctx, planText, plan.planId, {
			autoSubmit: plan.autoSubmit === true,
			timeoutMs: 60_000,
		});
		const livePlan = currentPlan();
		if (!isCurrentPlanApproval(livePlan, plan.planId, submission)) {
			return {
				content: [
					{
						type: "text" as const,
						text: "El resultado de la aprobación del plan quedó obsoleto; el modo plan cambió. No se tomó ninguna acción.",
					},
				],
				details: { isError: true, planId: plan.planId, status: "stale" },
			};
		}

		if (approved) {
			// APRUEBA: levanta el gate (desactiva así que el tool_call handler devuelve temprano),
			// persiste, luego despierta el mensaje de implementación.
			markPlanApproved(livePlan);
			persist(pi, livePlan);
			refreshPlanStatus(ctx);
			wake(pi, ctx, makeImplementPrompt(planText, { ultracodeSteps: livePlan.ultracodeSteps }));
			notify(ctx, `Plan ${livePlan.planId} aprobado. Saliendo del modo plan e implementando. 🐼`, "info");
			return {
				content: [{ type: "text" as const, text: "Plan aprobado — implementando ahora." }],
				details: { planId: livePlan.planId, status: "approved" },
			};
		}

		// RECHAZA: sigue en modo plan (gate sigue armado), cuéntalo, persiste, y devuelve al
		// modelo para que revise y reenvíe en el mismo turno. Sin wake.
		markPlanRejected(livePlan); // sigue activo; el status refleja que aún estamos planificando.
		persist(pi, livePlan);
		setPlanStatus(ctx, livePlan);
		notify(ctx, `Plan ${livePlan.planId} rechazado. Seguimos en modo plan; el agente va a revisar.`, "info");
		return {
			content: [
				{
					type: "text" as const,
					text: "Plan rechazado. Seguís en modo plan (solo lectura). Revisá el plan para atender las inquietudes del usuario y volvé a llamar a submit_plan.",
				},
			],
			details: { planId: livePlan.planId, status: "rejected", rejections: livePlan.rejections },
		};
	};
}
