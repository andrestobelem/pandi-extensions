/**
 * Plan-mode prompt builders (pure).
 *
 * Extracted verbatim from index.ts to isolate the canonical wording of the
 * planning posture and the post-approval implementation message from the
 * command/state wiring. Pure and side-effect free, so the prompt text has a
 * single home and is easy to review/test.
 *
 * Decoupled from `PlanState`: `makePlanningPrompt` takes only the minimal
 * structural fields it needs (planId/task + the optional posture flags), which
 * any `PlanState` satisfies. Depth-one sibling module imported by index.ts via
 * "./prompts.js".
 */

/**
 * Optional posture flags that tune the planning/implementation wording. All
 * default to false (the interactive, no-ultracode posture preserved verbatim):
 *
 * - nonInteractive: plan-only session (print/json or a workflow subagent). There
 *   is no human approval and no implementation; the deliverable is the PLAN. The
 *   read-only gate stays armed for the whole session, so mutation stays blocked.
 * - ultracode: tell the planner to lean on dynamic workflows to RESEARCH/DESIGN
 *   the plan (inspect the catalog read-only now; propose run/start steps).
 * - ultracodeSteps: tell the planner/implementer to execute the plan's STEPS via
 *   dynamic workflows when warranted (exhaustiveness, confidence, scale).
 */
export interface PlanFlags {
	nonInteractive?: boolean;
	ultracode?: boolean;
	ultracodeSteps?: boolean;
}

/** The planning instruction injected when /plan enters the mode. */
export function makePlanningPrompt(plan: { planId: string; task: string } & PlanFlags): string {
	const lines: string[] = [];
	lines.push(`Ahora estás en MODO PLAN (plan ${plan.planId}). Esta es una postura de planificación de SOLO LECTURA.`);
	lines.push("");
	lines.push("TAREA (textual):");
	lines.push(plan.task);
	lines.push("");
	if (plan.nonInteractive) {
		lines.push("SESIÓN NO INTERACTIVA (solo plan):");
		lines.push("- Acá no hay aprobación humana ni implementación. Tu único entregable es el PLAN en sí.");
		lines.push(
			"- El gate de solo lectura queda armado durante TODA la sesión; write/edit y el shell mutante siguen bloqueados.",
		);
		lines.push(
			"- Cuando el plan esté listo, llamá a submit_plan({ plan }) para registrarlo, y después DEVOLVÉ EL PLAN COMPLETO como tu respuesta final. NO intentes implementar.",
		);
		lines.push("");
	}
	lines.push("REGLAS mientras estás en modo plan (un gate las HACE CUMPLIR, no son solo una guía):");
	lines.push(
		"- SOLO podés usar acciones de solo lectura: read, grep, find, ls, y comandos de shell de solo lectura (p. ej. git ls-files, git status, cat, head, sed -n para ver contenido). Las tools mutantes (write, edit) y los comandos de shell mutantes (rm, mv, git commit/add/push/reset, redirecciones >/>>, instalación de paquetes, etc.) están BLOQUEADOS DE FORMA DURA y van a fallar. dynamic_workflow solo se permite para acciones de solo lectura (list/scaffold/read/graph/runs/view); write/run/start quedan bloqueados mientras planificás.",
	);
	lines.push("- NO empieces a implementar. La implementación ocurre solo DESPUÉS de que el usuario apruebe tu plan.");
	lines.push(
		"- Tu plan PUEDE incluir correr dynamic workflows (dynamic_workflow action=run/start) como pasos de implementación — esos se ejecutan solo DESPUÉS de la aprobación, así que proponelos para trabajo amplio, paralelo o de alta confianza (auditorías grandes, migraciones, barridos exhaustivos, verificación independiente, investigación profunda). Mientras planificás podés inspeccionar el catálogo en solo lectura (dynamic_workflow action=list/scaffold/read) para elegir o diseñar el workflow correcto, y después describirlo en el plan.",
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
	if (!plan.nonInteractive) {
		lines.push(
			"- Para aclarar requisitos antes de terminar el plan, podés hacerle al usuario una pregunta BLOQUEANTE con las tools interactivas cuando estén disponibles — ask_choice / ask_confirm (pi, de pi-ask) o AskUserQuestion (Claude Code) — si no, preguntá en texto plano. Limitalo a preguntas genuinamente bloqueantes.",
		);
	}
	lines.push("");
	lines.push("QUÉ HACER:");
	lines.push("1. INVESTIGÁ la tarea con tools de solo lectura hasta entenderla.");
	lines.push("2. DISEÑÁ un enfoque de implementación.");
	if (plan.nonInteractive) {
		lines.push(
			"3. Cuando el plan esté completo y autocontenido, llamá a submit_plan({ plan }) para registrarlo, y después mostrá el PLAN COMPLETO en Markdown como tu respuesta final.",
		);
		lines.push(
			"Esta es una sesión no interactiva: no hay paso de aprobación ni de implementación. El plan ES el resultado.",
		);
	} else {
		lines.push(
			"3. Cuando el plan esté completo y autocontenido, llamá a submit_plan({ plan }) con el plan de implementación COMPLETO en Markdown. Esto se lo presenta al usuario para su aprobación.",
		);
		lines.push(
			"Si se aprueba, vas a salir del modo plan y se te va a pedir que implementes. Si el plan se rechaza vas a recibir feedback y deberías revisarlo, y después volver a llamar a submit_plan.",
		);
	}
	return lines.join("\n");
}

/** El mensaje de implementación reinyectado después de que el usuario aprueba el plan. */
export function makeImplementPrompt(planText: string, opts: { ultracodeSteps?: boolean } = {}): string {
	const base = `Plan aprobado. Implementá ahora:\n\n${planText}`;
	if (!opts.ultracodeSteps) return base;
	return `${base}\n\nEjecutá los pasos marcados para ultracode vía dynamic_workflow (action=run/start) con concurrency/maxAgents explícitos; mantené el resto inline.`;
}
