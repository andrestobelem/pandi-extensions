/**
 * Presentación de status para `/loop`: notify (`formatStatus`) y barra TUI
 * (`setLoopStatus` / `clearLoopStatus` / `refreshLoopStatus`).
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { LOOP_STATUS_KEY } from "./constants.js";
import { formatLoopInterval } from "./interval.js";
import type { ActiveLoop, LoopMode, LoopStatus } from "./state.js";
import { formatEta } from "./time.js";

/** Subconjunto de LoopState que formatStatus necesita. */
export interface LoopStatusInput {
	loopId: string;
	task: string;
	status: LoopStatus;
	mode: LoopMode;
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

export function setLoopStatus(ctx: ExtensionContext, loop: LoopStatusInput): void {
	if (!ctx.hasUI) return;
	const theme = ctx.ui.theme;
	const paused = loop.status === "paused" ? " paused" : "";
	const fixed = loop.mode === "fixed" && loop.intervalMs ? ` @${formatLoopInterval(loop.intervalMs)}` : "";
	const eta = loop.status === "running" && loop.nextFireAt ? ` next ${formatEta(loop.nextFireAt)}` : "";
	const reason = loop.lastReason ? ` · ${loop.lastReason}` : "";
	ctx.ui.setStatus(
		LOOP_STATUS_KEY,
		`${theme.fg("accent", "↻ loop")} ${theme.fg("dim", `it ${loop.iteration}/${loop.maxIterations}${fixed}${paused}${eta}${reason}`)}`,
	);
}

export function clearLoopStatus(ctx: ExtensionContext): void {
	if (ctx.hasUI) ctx.ui.setStatus(LOOP_STATUS_KEY, undefined);
}

/** Muestra un loop activo en la barra; running tiene prioridad sobre paused. */
export function refreshLoopStatus(ctx: ExtensionContext, loops: Iterable<ActiveLoop>): void {
	if (!ctx.hasUI) return;
	for (const loop of loops) {
		if (loop.status === "running") {
			setLoopStatus(ctx, loop);
			return;
		}
	}
	for (const loop of loops) {
		if (loop.status === "paused") {
			setLoopStatus(ctx, loop);
			return;
		}
	}
	clearLoopStatus(ctx);
}
