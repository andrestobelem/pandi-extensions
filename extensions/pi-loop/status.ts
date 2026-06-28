/**
 * pi-loop status-line formatter (pure). Renders a single loop into the one-line
 * status string used by /loop status and the status bar. Extracted from index.ts
 * with the body verbatim; the only change is the parameter type, decoupled from
 * LoopState into a structural LoopStatusInput so this leaf has no cycle back to
 * index.ts. Depth-one sibling imported via "./status.js".
 */

import { formatEta } from "./time.js";
import { formatInterval } from "./interval.js";

/** Structural subset of LoopState that formatStatus reads. A full LoopState satisfies it. */
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
	const eta = loop.status === "running" ? `, next ${formatEta(loop.nextFireAt)}` : "";
	const mode =
		loop.mode === "fixed" && loop.intervalMs
			? ` every ${formatInterval(Math.round(loop.intervalMs / 1000))}`
			: "";
	const auto = loop.autonomous ? " auto" : "";
	const reason = loop.lastReason ? `, reason: ${loop.lastReason}` : "";
	return `${loop.loopId} [${loop.status}${auto}]${mode} it ${loop.iteration}/${loop.maxIterations}${eta}${reason} — ${loop.task}`;
}
