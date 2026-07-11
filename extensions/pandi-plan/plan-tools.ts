/**
 * Registro de tools del modo plan (submit_plan, enter_plan_mode).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createEnterPlanModeExecute } from "./enter-plan-mode-handler.js";
import { createSubmitPlanExecute, type SubmitPlanDeps } from "./submit-plan-handler.js";

export interface PlanArgumentCompletion {
	value: string;
	label: string;
	description: string;
}

export const PLAN_ARGUMENT_COMPLETIONS: PlanArgumentCompletion[] = [
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

export function registerPlanTools(pi: ExtensionAPI, submitDeps: SubmitPlanDeps): void {
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
		execute: createSubmitPlanExecute(submitDeps),
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
		execute: createEnterPlanModeExecute(pi),
	});
}
