/**
 * Formateador de línea de estado de pandi-loop (puro). Renderiza un loop único al
 * string de estado de una línea usado por /loop status y la status bar. Extraído de
 * index.ts con el cuerpo verbatim; el único cambio es el tipo del parámetro,
 * desacoplado de LoopState a un LoopStatusInput estructural para que esta hoja no tenga
 * ciclo de vuelta hacia index.ts. Hermano de profundidad uno importado vía "./status.js".
 */

import { formatInterval } from "./interval.js";
import { formatEta } from "./time.js";

/** Subconjunto estructural de LoopState que formatStatus lee. Un LoopState completo lo satisface. */
export interface LoopStatusInput {
	loopId: string;
	task: string;
	status: string;
	mode: "dynamic" | "fixed";
	intervalMs?: number;
	iteration: number;
	maxIterations: number;
	nextFireAt: number | null;
	lastReason?: string;
	autonomous?: boolean;
}

export function formatStatus(loop: LoopStatusInput): string {
	const eta = loop.status === "running" ? `, próximo ${formatEta(loop.nextFireAt)}` : "";
	const mode =
		loop.mode === "fixed" && loop.intervalMs ? ` cada ${formatInterval(Math.round(loop.intervalMs / 1000))}` : "";
	const auto = loop.autonomous ? " auto" : "";
	const reason = loop.lastReason ? `, razón: ${loop.lastReason}` : "";
	return `${loop.loopId} [${loop.status}${auto}]${mode} it ${loop.iteration}/${loop.maxIterations}${eta}${reason} — ${loop.task}`;
}
