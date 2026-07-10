/**
 * Política pura de caps de pandi-loop. Devuelve una stop-reason cuando un loop
 * supera wall-clock o presupuesto de contexto; el scheduler aplica el stop.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { WATCHDOG_HARD_DEADLINE_MS } from "./constants.js";

/** Subconjunto de ActiveLoop que capExceeded necesita. */
export interface LoopCapsInput {
	startedAt: number;
	maxWallClockMs: number;
	contextPercentCap: number;
}

/** Subconjunto para guards pre-wake (caps + iteraciones + watchdog opcional). */
export interface PreWakeLoopInput extends LoopCapsInput {
	iteration: number;
	maxIterations: number;
}

/** Chequea caps antes de rearmar; maxIterations se controla aparte al entregar wake. */
export function capExceeded(ctx: ExtensionContext, loop: LoopCapsInput): string | undefined {
	// Wall-clock, no monotónico: el deadline debe sobrevivir reloads/reinicios. Un salto
	// hacia atrás solo retrasa este cap; maxIterations queda como respaldo independiente.
	const elapsed = Date.now() - loop.startedAt;
	if (loop.maxWallClockMs > 0 && elapsed >= loop.maxWallClockMs) {
		return `alcanzó el deadline de wall-clock (${Math.round(loop.maxWallClockMs / 60000)}m)`;
	}
	// Best-effort: getContextUsage puede faltar o devolver percent null.
	const usage = ctx.getContextUsage?.();
	if (usage && usage.percent !== null && usage.percent >= loop.contextPercentCap) {
		return `presupuesto de contexto agotado (${Math.round(usage.percent)}% ≥ ${loop.contextPercentCap}%)`;
	}
	return undefined;
}

/**
 * Motivo canónico del deadline duro anti-zombie (compartido por fireWake y watchdogSweep).
 */
export function watchdogHardDeadlineReason(): string {
	return `watchdog: superó el deadline de respaldo duro (${Math.round(WATCHDOG_HARD_DEADLINE_MS / 3600000)}h)`;
}

export type PreWakeLimit =
	| { kind: "watchdog"; reason: string }
	| { kind: "maxIterations"; reason: string }
	| { kind: "cap"; reason: string };

/**
 * Guards pre-wake en un solo lugar. Orden de contrato: watchdog (si se pide) →
 * maxIterations → caps de wall-clock/contexto. Usado por fireWake (con watchdog)
 * y drainWakeQueue (sin watchdog: el timer ya disparó).
 */
export function preWakeLimit(
	ctx: ExtensionContext,
	loop: PreWakeLoopInput,
	opts: { includeWatchdog?: boolean; now?: number } = {},
): PreWakeLimit | undefined {
	const now = opts.now ?? Date.now();
	if (opts.includeWatchdog && now - loop.startedAt >= WATCHDOG_HARD_DEADLINE_MS) {
		return { kind: "watchdog", reason: watchdogHardDeadlineReason() };
	}
	if (loop.iteration >= loop.maxIterations) {
		return {
			kind: "maxIterations",
			reason: `alcanzó el límite de maxIterations (${loop.maxIterations})`,
		};
	}
	const cap = capExceeded(ctx, loop);
	if (cap) return { kind: "cap", reason: cap };
	return undefined;
}
