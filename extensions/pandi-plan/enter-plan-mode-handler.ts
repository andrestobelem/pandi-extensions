/**
 * Handler execute de la tool enter_plan_mode.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createAndArmPlan } from "./command-handler.js";
import { resolvePlanFlags } from "./flags.js";
import { notify } from "./notify.js";
import { currentPlan, planModeActive } from "./plan-guard.js";
import { forceInteractiveApprovalPosture } from "./posture.js";
import { makePlanningPrompt } from "./prompts.js";
import { canApproveInMode, canEnterPlanMode } from "./wake.js";

export type EnterPlanModeParams = {
	task: string;
	nonInteractive?: boolean;
	ultracode?: boolean;
	ultracodeSteps?: boolean;
};

export type EnterPlanModeDetails = {
	isError?: boolean;
	entered: boolean;
	reason?: string;
	planId?: string;
	status?: string;
};

type EnterPlanModeResult = {
	content: Array<{ type: "text"; text: string }>;
	details: EnterPlanModeDetails;
};

export function createEnterPlanModeExecute(pi: ExtensionAPI) {
	return async (
		_toolCallId: string,
		params: EnterPlanModeParams,
		_signal: AbortSignal | undefined,
		_onUpdate: unknown,
		ctx: ExtensionContext,
	): Promise<EnterPlanModeResult> => {
		const resolvedFlags = resolvePlanFlags(params);
		const flags = canApproveInMode(ctx) ? forceInteractiveApprovalPosture(resolvedFlags) : resolvedFlags;
		if (!canEnterPlanMode(ctx, flags)) {
			notify(
				ctx,
				"No se puede entrar en modo plan acá: esta sesión no es interactiva. Pasá nonInteractive (o seteá PI_PLAN_NONINTERACTIVE) para una sesión solo-plan, o seguí sin modo plan.",
				"warning",
			);
			return {
				content: [
					{
						type: "text" as const,
						text: "El modo plan requiere una sesión TUI o RPC para ejecutar el protocolo de aprobación. Para una sesión no interactiva, pasá nonInteractive:true (solo plan: produce un plan, sin implementación) o seteá PI_PLAN_NONINTERACTIVE=1. Si no, no entres en modo plan; seguí con la tarea normalmente.",
					},
				],
				details: { entered: false, reason: "mode" },
			};
		}
		const trimmed = params.task.trim();
		if (!trimmed) {
			return {
				content: [
					{
						type: "text" as const,
						text: "enter_plan_mode requiere una task no vacía que describa qué planificar.",
					},
				],
				details: { isError: true, entered: false, reason: "empty-task" },
			};
		}
		if (planModeActive()) {
			const current = currentPlan();
			return {
				content: [
					{
						type: "text" as const,
						text: `El modo plan ya está activo${current ? ` (${current.planId})` : ""}. Seguí investigando en solo lectura, y llamá a submit_plan cuando tu plan esté listo.`,
					},
				],
				details: { entered: false, reason: "already-active", planId: current?.planId },
			};
		}

		const plan = createAndArmPlan(pi, ctx, trimmed, flags);
		notify(
			ctx,
			plan.nonInteractive
				? `Pi entró en modo plan (${plan.planId}, solo plan). Solo lectura; el plan es el entregable. Tarea: ${trimmed}`
				: `Pi entró en modo plan (${plan.planId}). Solo lectura hasta que apruebes un plan. Tarea: ${trimmed}`,
			"info",
		);
		return {
			content: [{ type: "text" as const, text: makePlanningPrompt(plan) }],
			details: { entered: true, planId: plan.planId, status: "planning" },
		};
	};
}
