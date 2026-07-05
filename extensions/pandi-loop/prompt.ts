/**
 * Constructor del prompt de iteración de pandi-loop (puro). El molde estable que se
 * reinyecta en cada iteración (objetivo autónomo vs tarea verbatim; guía de cadencia
 * fija vs dinámica). Extraído de index.ts con el cuerpo verbatim; el único cambio es
 * el tipo del parámetro, desacoplado de LoopState a un input estructural para que esta
 * hoja no tenga ciclo de vuelta hacia index.ts. Hermano de profundidad uno importado vía
 * "./prompt.js".
 */

import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { formatInterval } from "./interval.js";

/** Subconjunto estructural de LoopState que makeLoopIterationPrompt lee. Un LoopState completo lo satisface. */
export interface LoopIterationPromptInput {
	loopId: string;
	task: string;
	mode: "dynamic" | "fixed";
	intervalMs?: number;
	iteration: number;
	maxIterations: number;
	lastReason?: string;
	autonomous?: boolean;
	ultracode?: boolean;
}

/** Molde estable de prompt de iteración (cf. makeWorkflowWakePrompt). */
export function makeLoopIterationPrompt(loop: LoopIterationPromptInput): string {
	const lines: string[] = [];
	lines.push(`Estás corriendo una iteración de /loop (loop ${loop.loopId}).`);
	lines.push("");
	if (loop.autonomous) {
		// Modo autónomo (P2): sin tarea de usuario convencional. El campo "task" contiene el
		// objetivo recurrente; el texto reinyectado es esta sentinela, no un mensaje de usuario.
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
		// Modo fijo: el período pertenece a la extensión; el modelo solo decide continuar vs
		// detenerse. loop_schedule es un no-op acá (no puede cambiar la cadencia).
		const periodSec = Math.round((loop.intervalMs ?? 0) / 1000);
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
	return lines.join("\n");
}
