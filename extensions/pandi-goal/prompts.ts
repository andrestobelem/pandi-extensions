/**
 * Prompt molds for the `/goal` extension.
 *
 * Pure prompt-construction helpers: they turn a GoalState into the text re-injected each
 * `pursuing` iteration or `verifying` completeness check. No side effects, no scheduling,
 * no I/O — just string building — so they are trivially testable and depend only on the
 * type/constant leaves. The independent-verifier prompt stays with the verifier code in
 * index.ts and reuses effectiveCriteria/formatProgressLog imported from here.
 */

import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { PROGRESS_LOG_KEEP } from "./constants.js";
import type { GoalState } from "./types.js";

/** The effective criteria text: user-supplied wins, else model-derived, else none yet. */
export function effectiveCriteria(goal: GoalState): string | undefined {
	if (goal.successCriteria?.trim()) return goal.successCriteria.trim();
	if (goal.derivedCriteria?.trim()) return goal.derivedCriteria.trim();
	return undefined;
}

/** Compact progress log of the last N assessments, for continuity without re-reading the session. */
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

/** Stable iteration-prompt mold re-injected each `pursuing` iteration. */
export function makeGoalIterationPrompt(goal: GoalState): string {
	const lines: string[] = [];
	lines.push(`Estás persiguiendo un /goal (goal ${goal.goalId}).`);
	lines.push("");
	lines.push("OBJETIVO (textual):");
	lines.push(goal.objective);
	lines.push("");

	const criteria = effectiveCriteria(goal);
	if (criteria) {
		lines.push("CRITERIOS DE ÉXITO (definición de terminado):");
		lines.push(criteria);
	} else {
		lines.push("CRITERIOS DE ÉXITO: no se proporcionaron.");
		lines.push(
			"PRIMERO, derivá 2 a 5 criterios de éxito concretos y VERIFICABLES a partir del objetivo (cada uno chequeable con un comando, un test o un artifact inspeccionable). Pasalos en el argumento `successCriteria` de tu PRIMER llamado a goal_progress (NO solo en `assessment`); quedan registrados UNA VEZ como la definición de terminado para el resto de este goal.",
		);
	}
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
	return lines.join("\n");
}

/** Verification-prompt mold, injected only in the `verifying` state (the completeness check). */
export function makeGoalVerificationPrompt(goal: GoalState): string {
	const lines: string[] = [];
	lines.push(`CHEQUEO DE COMPLETITUD para /goal ${goal.goalId}.`);
	lines.push("");
	lines.push("OBJETIVO (textual):");
	lines.push(goal.objective);
	lines.push("");
	const criteria = effectiveCriteria(goal);
	if (criteria) {
		lines.push("CRITERIOS DE ÉXITO (definición de terminado):");
		lines.push(criteria);
		lines.push("");
	}
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
	return lines.join("\n");
}
