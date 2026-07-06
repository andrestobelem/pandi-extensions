/**
 * Política pura de caps de pandi-loop. Devuelve una stop-reason cuando un loop
 * supera wall-clock o presupuesto de contexto; el scheduler aplica el stop.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Subconjunto de ActiveLoop que capExceeded necesita. */
export interface LoopCapsInput {
	startedAt: number;
	maxWallClockMs: number;
	contextPercentCap: number;
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
		return `alcanzó el presupuesto de contexto (${Math.round(usage.percent)}% ≥ ${loop.contextPercentCap}%)`;
	}
	return undefined;
}
