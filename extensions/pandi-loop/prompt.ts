/**
 * Constructor puro del prompt de iteración de pandi-loop. Usa un input estructural
 * para evitar que esta hoja dependa del estado runtime de index.ts.
 */

import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { formatInterval } from "./interval.js";
import type { LoopSchedule } from "./state.js";

/** Subconjunto de LoopState que makeLoopIterationPrompt necesita. */
interface LoopIterationPromptFields {
	loopId: string;
	task: string;
	iteration: number;
	maxIterations: number;
	lastReason?: string;
	autonomous?: boolean;
	ultracode?: boolean;
}

export type LoopIterationPromptInput = LoopIterationPromptFields & LoopSchedule;

function renderLoopIterationPrompt(lines: string[]): string {
	return lines.join("\n");
}

/** Molde estable de prompt de iteración (cf. makeWorkflowWakePrompt). */
export function makeLoopIterationPrompt(loop: LoopIterationPromptInput): string {
	const lines: string[] = [];
	lines.push(`Estás corriendo una iteración de /loop (loop ${loop.loopId}).`);
	lines.push("");
	if (loop.autonomous) {
		// El campo "task" guarda el objetivo recurrente; el prompt reinyectado usa esta sentinela.
		lines.push("LOOP AUTÓNOMO (sin usuario interactivo este turno).");
		lines.push("Esta iteración fue generada por la extensión /loop para perseguir un objetivo recurrente:");
		lines.push("");
		lines.push("OBJETIVO (textual):");
		lines.push(loop.task);
		lines.push("");
		lines.push(
			"Hacé progreso autónomo sobre el objetivo, pero mantenete conservador: las acciones destructivas/irreversibles quedan bloqueadas este turno. Si necesitás una decisión humana, parate y exponéla en vez de adivinar.",
		);
		lines.push("");
	} else {
		lines.push("TAREA (textual):");
		lines.push(loop.task);
		lines.push("");
	}
	lines.push(`Esta es la iteración ${loop.iteration}/${loop.maxIterations}.`);
	if (loop.lastReason) {
		lines.push(`Decisión anterior: ${loop.lastReason}`);
	}
	if (loop.ultracode) {
		lines.push(
			`ULTRACODE: preferí conducir este trabajo vía dynamic workflows cuando eso justifique su costo. Primero scouteá inline con sondas baratas de solo lectura; orquestá (dynamic_workflow action=start) solo para exhaustividad, confianza independiente o escala, con concurrency/maxAgents explícitos. Revisá el catálogo (dynamic_workflow action=scaffold) y reusá un workflow que calce exacto, o escribí un draft gitignoreado en ${CONFIG_DIR_NAME}/workflows/drafts/<slug>.js.`,
		);
	}
	lines.push("");
	lines.push("Hacé EXACTAMENTE UNA iteración de la tarea ahora, y después decidí si continuar:");
	if (loop.mode === "fixed") {
		// El período pertenece a la extensión; el modelo solo decide continuar o detenerse.
		const periodSec = Math.round(loop.intervalMs / 1000);
		lines.push(
			`- Este loop corre en un intervalo FIJO (cada ${formatInterval(periodSec)}). NO controlás la cadencia; no intentes cambiarla.`,
		);
		lines.push(
			"- Si queda más trabajo, simplemente terminá esta iteración; la próxima se va a disparar automáticamente según lo programado.",
		);
		lines.push(
			"- Si la tarea está completa o más iteraciones no ayudan, llamá a loop_stop(reason) para terminar el loop.",
		);
		lines.push(
			`El loop va a seguir disparando en su intervalo fijo y va a detenerse de forma dura en la iteración ${loop.maxIterations} (o cuando se agote su presupuesto de tiempo).`,
		);
	} else {
		lines.push(
			"- Si hace falta más trabajo o esperar, llamá a loop_schedule(delaySeconds, reason) para programar la próxima iteración. Pensá QUÉ estás esperando, no cuánto tiempo querés dormir; elegí una cadencia acorde.",
		);
		lines.push(
			"- Si la tarea está completa o más iteraciones no ayudan, llamá a loop_stop(reason) para terminar el loop.",
		);
		lines.push(
			`Si no hacés ninguna de las dos, el loop se va a reprogramar automáticamente por defensa y se va a detener de forma dura en la iteración ${loop.maxIterations}.`,
		);
	}
	return renderLoopIterationPrompt(lines);
}
