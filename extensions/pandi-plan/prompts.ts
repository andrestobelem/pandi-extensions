/**
 * Armadores de prompts de modo plan (puros).
 *
 * Extraídos verbatim de index.ts para aislar el wording canónico de la
 * postura de planificación y el mensaje de implementación post-aprobación del
 * cableado de comando/state. Puros y sin side-effects, así que el texto del prompt tiene
 * un hogar único y es fácil de revisar/testear.
 *
 * Desacoplados de `PlanState`: `makePlanningPrompt` toma solo los campos
 * estructurales mínimos que necesita (planId/task + las banderas de postura opcionales), que
 * cualquier `PlanState` satisface. Módulo sibling de profundidad uno importado por index.ts vía
 * "./prompts.js".
 */

import type { PlanPosture } from "./posture.js";

export type { PlanFlags, PlanPosture } from "./posture.js";

function renderPlanningPrompt(lines: string[]): string {
	return lines.join("\n");
}

/** La instrucción de planificación inyectada cuando /plan entra al modo. */
export function makePlanningPrompt(plan: { planId: string; task: string } & PlanPosture): string {
	const lines: string[] = [];
	lines.push(`Ahora estás en MODO PLAN (plan ${plan.planId}). Esta es una postura de planificación de SOLO LECTURA.`);
	lines.push("");
	lines.push("TAREA (textual):");
	lines.push(plan.task);
	lines.push("");
	if (plan.nonInteractive) {
		lines.push("SESIÓN NO INTERACTIVA (solo plan):");
		lines.push(
			"- No hay aprobación ni implementación: el gate read-only sigue activo toda la sesión y el PLAN es el único entregable.",
		);
		lines.push("");
	}
	lines.push("REGLAS (el gate las hace cumplir):");
	lines.push("- Investigá solo con herramientas y comandos read-only; las mutaciones están bloqueadas.");
	lines.push("- No implementes hasta que el usuario apruebe explícitamente el plan.");
	lines.push(
		"- El plan puede proponer dynamic workflows (dynamic_workflow action=run/start) para pasos posteriores a la aprobación. Durante planificación, inspeccioná el catálogo solo en modo read-only (list/scaffold/read/graph) y nombrá el workflow cuando aporte exhaustividad, confianza o escala.",
	);
	if (plan.ultracode) {
		lines.push(
			"- ULTRACODE: apoyate en dynamic workflows para INVESTIGAR y DISEÑAR este plan. Inspeccioná el catálogo en solo lectura ahora (dynamic_workflow action=list/scaffold/read/graph) y hacé que el plan nombre los workflows run/start que van a ejecutar el trabajo después de la aprobación, con concurrency/maxAgents explícitos.",
		);
	}
	if (plan.ultracodeSteps) {
		lines.push(
			"- ULTRACODE STEPS: estructurá el plan para que sus PASOS se ejecuten vía dynamic workflows cuando se justifique (exhaustividad, confianza, escala). Para cada paso, indicá si corre como workflow y con qué concurrency/maxAgents, o si corre inline.",
		);
	}
	if (plan.autoSubmit && !plan.nonInteractive) {
		lines.push(
			"- AUTO-SUBMIT: cuando llames a submit_plan, el overlay de aprobación se auto-aprobará tras 60 segundos si el usuario no elige antes. Por eso el plan debe ser completo, autocontenido y seguro de aprobar por timeout.",
		);
	}
	if (!plan.nonInteractive) {
		lines.push(
			"- Para aclarar requisitos antes de terminar el plan, podés hacerle al usuario una pregunta BLOQUEANTE con las tools interactivas cuando estén disponibles — ask_choice / ask_confirm (pi, de pandi-ask) o AskUserQuestion (Claude Code) — si no, preguntá en texto plano. Limitalo a preguntas genuinamente bloqueantes.",
		);
	}
	lines.push("");
	lines.push("QUÉ HACER:");
	lines.push("1. INVESTIGÁ la tarea con tools de solo lectura hasta entenderla.");
	lines.push("2. DISEÑÁ un enfoque de implementación.");
	if (plan.nonInteractive) {
		lines.push(
			"3. Cuando el plan esté completo y autocontenido, llamá a submit_plan({ plan }) para registrarlo y mostrá el PLAN COMPLETO en Markdown como respuesta final.",
		);
		lines.push("Esta es una sesión no interactiva: el plan ES el resultado.");
	} else {
		lines.push(
			"3. Cuando el plan esté completo y autocontenido, llamá a submit_plan({ plan }) con el plan de implementación COMPLETO en Markdown. Esto se lo presenta al usuario para su aprobación.",
		);
		lines.push(
			"Si se aprueba, vas a salir del modo plan y se te va a pedir que implementes. Si el plan se rechaza vas a recibir feedback y deberías revisarlo, y después volver a llamar a submit_plan.",
		);
	}
	return renderPlanningPrompt(lines);
}

/** El mensaje de implementación reinyectado después de que el usuario aprueba el plan. */
export function makeImplementPrompt(planText: string, opts: { ultracodeSteps?: boolean } = {}): string {
	const base = [
		"Plan aprobado. Implementá ahora.",
		"",
		"Contrato de ejecución:",
		"- Respetá el alcance y los non-goals aprobados; no agregues trabajo no acordado.",
		"- Preservá cambios ajenos: no limpies, resetees, formatees ni commitees archivos fuera de la tarea.",
		"- Verificá cada criterio de éxito con evidencia observable antes de declarar terminado.",
		"",
		"PLAN APROBADO:",
		"",
		planText,
	].join("\n");
	if (!opts.ultracodeSteps) return base;
	return `${base}\n\nEjecutá los pasos marcados para ultracode vía dynamic_workflow (action=run/start) con concurrency/maxAgents explícitos; mantené el resto inline.`;
}
