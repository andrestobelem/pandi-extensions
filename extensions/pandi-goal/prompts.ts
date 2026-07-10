/**
 * Moldes de prompt para la extensión `/goal`.
 *
 * Helpers puros de construcción de prompts: convierten un GoalState en el texto
 * reinyectado en cada iteración `pursuing` o chequeo de completitud `verifying`. Sin
 * side effects, sin scheduling, sin I/O: solo armado de strings, así que son triviales de
 * testear y dependen solo de las hojas de tipos/constantes. El prompt del verificador
 * independiente queda con el código del verificador en index.ts y reutiliza
 * effectiveCriteria/formatProgressLog importados desde acá.
 */

import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { PROGRESS_LOG_KEEP } from "./constants.js";
import type { GoalState } from "./types.js";

/** Texto efectivo de criterios: ganan los provistos por el usuario; si no, los derivados por el modelo; si no, nada aún. */
export function effectiveCriteria(goal: GoalState): string | undefined {
	if (goal.successCriteria?.trim()) return goal.successCriteria.trim();
	if (goal.derivedCriteria?.trim()) return goal.derivedCriteria.trim();
	return undefined;
}

/** Log de progreso compacto de las últimas N assessments, para continuidad sin releer la sesión. */
export function formatProgressLog(goal: GoalState): string[] {
	const lines: string[] = [];
	const recent = goal.assessments.slice(-PROGRESS_LOG_KEEP);
	if (recent.length === 0) return lines;
	lines.push("REGISTRO DE PROGRESO (más reciente al final):");
	for (const a of recent) {
		const step = a.nextStep ? ` próximo: ${a.nextStep}` : "";
		lines.push(`- iter ${a.iteration} [${a.status}] ${a.assessment}${step}`);
	}
	return lines;
}

function renderPromptLines(lines: string[]): string {
	return lines.join("\n");
}

function renderGoalAndCriteriaBlock(
	goal: GoalState,
	options: { includeMissingCriteriaGuidance: boolean },
): { lines: string[]; hasCriteria: boolean } {
	const lines: string[] = [];
	lines.push("OBJETIVO (textual):");
	lines.push(goal.objective);
	lines.push("");

	const criteria = effectiveCriteria(goal);
	if (criteria) {
		lines.push("CRITERIOS DE ÉXITO (definición de terminado):");
		lines.push(criteria);
	} else if (options.includeMissingCriteriaGuidance) {
		lines.push("CRITERIOS DE ÉXITO: no se proporcionaron.");
		lines.push(
			"PRIMERO, derivá 2 a 5 criterios de éxito concretos y VERIFICABLES a partir del objetivo (cada uno chequeable con un comando, un test o un artifact inspeccionable). Pasalos en el argumento `successCriteria` de tu PRIMER llamado a goal_progress (NO solo en `assessment`); quedan registrados UNA VEZ como la definición de terminado para el resto de este goal.",
		);
	}
	return { lines, hasCriteria: Boolean(criteria) };
}

/** Molde estable del prompt de iteración reinyectado en cada iteración `pursuing`. */
export function makeGoalIterationPrompt(goal: GoalState): string {
	const lines: string[] = [];
	lines.push(`Estás persiguiendo un /goal (goal ${goal.goalId}).`);
	lines.push("");
	lines.push(...renderGoalAndCriteriaBlock(goal, { includeMissingCriteriaGuidance: true }).lines);
	lines.push("");

	const log = formatProgressLog(goal);
	if (log.length) {
		lines.push(...log);
		lines.push("");
	}

	lines.push(`Esta es la iteración ${goal.iteration}/${goal.maxIterations}.`);
	if (goal.lastReason) lines.push(`Decisión previa: ${goal.lastReason}`);
	if (goal.ultracode) {
		lines.push(
			`ULTRACODE: preferí conducir este trabajo vía dynamic workflows cuando eso justifique su costo. Primero scouteá inline con sondas baratas de solo lectura; orquestá (dynamic_workflow action=start) solo para exhaustividad, confianza independiente o escala, con concurrency/maxAgents explícitos. Revisá el catálogo (dynamic_workflow action=scaffold) y reusá un workflow que calce exacto, o escribí un draft gitignoreado en ${CONFIG_DIR_NAME}/workflows/drafts/<slug>.js.`,
		);
	}
	lines.push("");
	lines.push(
		"Trabajá en el objetivo ahora. LUEGO autoevaluá tu progreso contra los criterios de éxito y llamá a goal_progress:",
	);
	lines.push('- estado "continue" (con un nextStep concreto) si todavía no se cumplen todos los criterios.');
	lines.push(
		'- estado "done" solo cuando creas que se cumple CADA criterio; luego vas a tener un turno de verificación antes de que el goal se cierre.',
	);
	lines.push(
		'- estado "blocked" si no podés avanzar sin una decisión humana, credencial o acceso (explicá el blocker).',
	);
	lines.push(
		`Si no llamás a ninguno, el goal se va a rearmar defensivamente y se va a detener de forma dura en la iteración ${goal.maxIterations}.`,
	);
	return renderPromptLines(lines);
}

/** Molde del prompt de verificación, inyectado solo en el estado `verifying` (el chequeo de completitud). */
export function makeGoalVerificationPrompt(goal: GoalState): string {
	const lines: string[] = [];
	lines.push(`CHEQUEO DE COMPLETITUD para /goal ${goal.goalId}.`);
	lines.push("");
	const context = renderGoalAndCriteriaBlock(goal, { includeMissingCriteriaGuidance: false });
	lines.push(...context.lines);
	if (context.hasCriteria) lines.push("");
	lines.push("Declaraste el objetivo completo. NO hagas trabajo nuevo ahora. VERIFICÁ de forma adversarial:");
	lines.push(
		"- Para CADA criterio de éxito, presentá evidencia concreta de que se cumple (un comando que corriste y su salida, un test que pasó, un archivo que existe). No afirmes; mostrá.",
	);
	lines.push(
		'- Si cada criterio está respaldado por evidencia, llamá a goal_progress({status:"done", assessment}) para CONFIRMAR y cerrar el goal.',
	);
	lines.push(
		'- Si algún criterio falla o falta evidencia, llamá a goal_progress({status:"continue", nextStep}) describiendo exactamente qué falta hacer.',
	);
	return renderPromptLines(lines);
}
