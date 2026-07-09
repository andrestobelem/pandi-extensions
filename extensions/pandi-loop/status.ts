/** Formateador puro de la línea usada por /loop status y la status bar. */

import { formatLoopInterval } from "./interval.js";
import { formatEta } from "./time.js";

/** Subconjunto de LoopState que formatStatus necesita. */
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
	const mode = loop.mode === "fixed" && loop.intervalMs ? ` cada ${formatLoopInterval(loop.intervalMs)}` : "";
	const auto = loop.autonomous ? " auto" : "";
	const reason = loop.lastReason ? `, razón: ${loop.lastReason}` : "";
	return `${loop.loopId} [${loop.status}${auto}]${mode} it ${loop.iteration}/${loop.maxIterations}${eta}${reason} — ${loop.task}`;
}
