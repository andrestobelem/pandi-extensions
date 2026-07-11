/**
 * `/plan` de estilo Claude ("modo plan") para Pi (P0).
 *
 * El modo plan pone el agente PRINCIPAL en una postura de planificación DE SOLO LECTURA. Mientras está activo,
 * el agente PUEDE INVESTIGAR (read/grep/find/ls + bash de solo lectura) y PRODUCIR un plan,
 * pero NO PUEDE mutar el workspace. El entregable es un artifact PLAN, presentado
 * para aprobación EXPLÍCITA del usuario, y solo si se aprueba el agente SALE del modo e
 * IMPLEMENTA.
 *
 * Arquitectura (modularizada al estilo pandi-loop):
 * - activePlans en memoria + persist JSONL vía persistence.ts
 * - session_start rehidrata vía rehydrate.ts
 * - wake post-aprobación vía wake.ts
 * - gate de solo lectura en gate.ts + tool-call-handler.ts
 * - comandos en command-handler.ts
 *
 * Reglas duras:
 * - gate print/json: ctx.mode debe ser tui/rpc; print/json → notify + rechaza entrar
 * - nunca reinyectes fuera de tui/rpc.
 * - en "fork" NO migres el plan-mode.
 * - el allowlist de solo lectura es BEST-EFFORT y está documentado (ver blockedReason).
 *
 * AUTÓNOMO: este archivo no importa de extensions/loop/index.ts o extensions/goal/index.ts;
 * patrones (notify, persist vía appendEntry, rehydrate, línea de estado, wake) se copian.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	configureCommandHandler,
	createAndArmPlan,
	handlePlanCommand,
	resetPlanSessionDefaults,
} from "./command-handler.js";
import { resolvePlanFlags } from "./flags.js";
import { notify } from "./notify.js";
import { persist } from "./persistence.js";
import { configurePlanGuard, currentPlan, planModeActive } from "./plan-guard.js";
import { forceInteractiveApprovalPosture } from "./posture.js";
import { makePlanningPrompt } from "./prompts.js";
import { configureRehydrate, rehydrate } from "./rehydrate.js";
import type { PlanState } from "./state.js";
import { clearPlanStatus, setPlanStatus } from "./status.js";
import { createSubmitPlanExecute } from "./submit-plan-handler.js";
import { handleToolCall } from "./tool-call-handler.js";
import { canApproveInMode, canEnterPlanMode, wake } from "./wake.js";

export {
	isPlanModeActive,
	PLAN_MODE_GUARD,
	PLAN_MODE_GUARD_SYMBOL,
	type PlanModeGuard,
} from "./plan-guard.js";
export type { PlanState, PlanStatus } from "./state.js";

// Fuente de verdad de "¿está el modo plan activo AHORA?" en este proceso.
const activePlans = new Map<string, PlanState>();

function refreshPlanStatus(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	const plan = currentPlan();
	if (plan) setPlanStatus(ctx, plan);
	else clearPlanStatus(ctx);
}

// ---------------------------------------------------------------------------
// Punto de entrada de la extensión
// ---------------------------------------------------------------------------

export default function planExtension(pi: ExtensionAPI): void {
	configurePlanGuard({ getActivePlans: () => activePlans });
	configureRehydrate({ getActivePlans: () => activePlans, refreshPlanStatus });
	configureCommandHandler({ getActivePlans: () => activePlans, refreshPlanStatus });

	pi.registerTool({
		name: "submit_plan",
		label: "Enviar plan",
		description:
			"Presentale al usuario tu plan de implementación terminado para que lo apruebe (≈ ExitPlanMode). Es la ÚNICA forma de terminar el modo plan. Si se aprueba, salís del modo plan e implementás; si se rechaza, seguís en modo plan y revisás.",
		promptSnippet: "Enviále al usuario tu plan de implementación de /plan para que lo apruebe.",
		promptGuidelines: [
			"Investigá PRIMERO con tools de solo lectura. No podés editar/escribir ni correr comandos de shell mutantes mientras planificás — están bloqueados de forma dura.",
			"Cuando el plan esté completo y autocontenido, llamá a submit_plan con el plan COMPLETO en Markdown. No empieces a implementar: la implementación ocurre solo después de que el usuario apruebe.",
			"Si el plan se rechaza, vas a recibir el rechazo de vuelta; revisá el plan para atender el feedback y volvé a llamar a submit_plan.",
		],
		parameters: Type.Object({
			plan: Type.String({
				minLength: 1,
				description:
					"El plan de implementación completo en Markdown, listo para presentarle al usuario para su aprobación.",
			}),
		}),
		executionMode: "sequential",
		execute: createSubmitPlanExecute({
			pi,
			currentPlan,
			persist,
			refreshPlanStatus,
			wake,
		}),
	});

	pi.registerTool({
		name: "enter_plan_mode",
		label: "Entrar en modo plan",
		description:
			"Entrá vos mismo en modo plan de solo lectura antes de implementar un cambio no trivial, de varios pasos, o riesgoso. Arma un gate de solo lectura (write/edit y los comandos de shell mutantes quedan bloqueados de forma dura) para que investigues en solo lectura y redactes un plan, y después lo presentes vía submit_plan para la aprobación explícita del usuario antes de cualquier edición. Necesita una sesión TUI/RPC.",
		promptSnippet: "Entrá en modo plan de solo lectura para investigar y presentar un plan antes de implementar.",
		promptGuidelines: [
			"Usá enter_plan_mode por tu propia iniciativa cuando el pedido del usuario sea no trivial, de varios pasos, ambiguo, destructivo, o de alcance amplio (refactors, migraciones, cambios de schema/arquitectura, cualquier cosa que toque muchos archivos) y todavía NO haya aprobado un enfoque concreto — arma un gate de solo lectura para que investigues de forma segura, y después llamás a submit_plan para la aprobación explícita antes de cualquier edición.",
			"NO uses enter_plan_mode para trabajo trivial, de un solo paso, de solo lectura, o ya aprobado, para responder preguntas, o cuando un plan, /goal, o /loop ya está conduciendo el turno — hacé eso directamente.",
			"enter_plan_mode necesita una aprobación interactiva, así que solo tiene efecto en una sesión TUI o RPC; si reporta que no pudo entrar (modo no interactivo) o que el modo plan ya está activo, NO reintentes — seguí con la tarea (o, si ya estás planificando, seguí investigando en solo lectura y llamá a submit_plan).",
			"Después de enter_plan_mode quedás en SOLO LECTURA: write/edit y los comandos de shell mutantes quedan bloqueados de forma dura hasta que el usuario apruebe tu plan, así que terminá de investigar y después llamá a submit_plan — la implementación ocurre solo después de la aprobación.",
			"Tu plan PUEDE incluir correr dynamic workflows (dynamic_workflow action=run/start) como pasos de implementación posteriores a la aprobación para trabajo amplio, paralelo, o de alta confianza (auditorías grandes, migraciones, barridos exhaustivos, verificación independiente, investigación profunda); mientras planificás podés inspeccionar el catálogo en solo lectura (dynamic_workflow action=list/scaffold/read) para elegir o diseñar el indicado y describirlo en el plan.",
		],
		parameters: Type.Object({
			task: Type.String({
				minLength: 1,
				description:
					"La tarea que pensás planificar antes de implementar (lo que vas a investigar y para lo que vas a escribir un plan).",
			}),
			nonInteractive: Type.Optional(
				Type.Boolean({
					description:
						"Solo plan: entrá incluso en una sesión no interactiva (print/json), p. ej. un subagente de dynamic-workflow. No hay aprobación ni implementación; el plan es el entregable y el gate de solo lectura nunca se levanta. Por defecto toma el valor de PI_PLAN_NONINTERACTIVE.",
				}),
			),
			ultracode: Type.Optional(
				Type.Boolean({
					description:
						"Decile al planificador que investigue/diseñe el plan usando dynamic workflows (ultracode). Por defecto toma el valor de PI_PLAN_ULTRACODE.",
				}),
			),
			ultracodeSteps: Type.Optional(
				Type.Boolean({
					description:
						"Decile al planificador/implementador que ejecute los PASOS del plan vía dynamic workflows cuando se justifique. Por defecto toma el valor de PI_PLAN_ULTRACODE_STEPS.",
				}),
			),
		}),
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
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
		},
	});

	pi.registerCommand("plan", {
		description:
			"Entrá en modo plan de solo lectura: /plan [--ultracode] [--ultracode-steps] [--auto-submit] <task> — investigá en solo lectura, escribí un plan, envialo para aprobación, y después implementá. /plan status | /plan dashboard | /plan exit | /plan cancel.",
		getArgumentCompletions: (argumentPrefix: string) => {
			const items = [
				{ value: "status", label: "status", description: "Mostrar el estado del modo plan" },
				{ value: "dashboard", label: "dashboard", description: "Abrir el dashboard de seguimiento del modo plan" },
				{ value: "--ultracode", label: "--ultracode", description: "Planificar usando dynamic workflows" },
				{
					value: "--ultracode-steps",
					label: "--ultracode-steps",
					description: "Ejecutar los pasos del plan vía dynamic workflows",
				},
				{
					value: "--auto-submit",
					label: "--auto-submit",
					description: "Aprobar automáticamente el plan tras 60s sin elección",
				},
				{
					value: "ultracode",
					label: "ultracode",
					description: "Alternar el valor por defecto de sesión: on|off|status",
				},
				{
					value: "steps-ultracode",
					label: "steps-ultracode",
					description: "Alternar el valor por defecto de sesión de pasos-vía-workflows: on|off|status",
				},
				{
					value: "auto-submit",
					label: "auto-submit",
					description: "Alternar auto-aprobación tras 60s sin elección: on|off|status",
				},
				{ value: "exit", label: "exit", description: "Salir del modo plan sin implementar" },
				{ value: "cancel", label: "cancel", description: "Salir del modo plan sin implementar" },
			];
			const prefix = argumentPrefix.trim().toLowerCase();
			if (!prefix) return items;
			return items.filter((i) => i.value.toLowerCase().startsWith(prefix));
		},
		handler: async (args, ctx) => await handlePlanCommand(pi, args, ctx),
	});

	pi.on("tool_call", async (event, _ctx) => await handleToolCall(event));

	pi.on("session_start", async (event, ctx) => {
		activePlans.clear();
		resetPlanSessionDefaults();
		if (event.reason === "fork") return;
		rehydrate(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		const plan = currentPlan();
		if (plan) persist(pi, plan);
		clearPlanStatus(ctx);
	});
}
