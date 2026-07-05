/**
 * Política de caps de pandi-loop (pura). Decide si un loop llegó a un cap HARD
 * (deadline absoluto de wall-clock) o a un cap de presupuesto best-effort
 * (porcentaje de context-usage), devolviendo una stop-reason legible para humanos o
 * undefined. Sin estado compartido, sin FIFO, sin efectos secundarios: el scheduler
 * (fireWake / drainWakeQueue / rehydrate / agent_end) importa esto y es dueño del
 * stop imperativo. Extraído de index.ts con el cuerpo verbatim; solo el parámetro
 * loop se desacopla de ActiveLoop a un LoopCapsInput estructural. Hermano de
 * profundidad uno importado vía "./caps.js".
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Subconjunto estructural del estado del loop que capExceeded lee. ActiveLoop lo satisface. */
export interface LoopCapsInput {
	startedAt: number;
	maxWallClockMs: number;
	contextPercentCap: number;
}

/**
 * Gate de caps (P1). Devuelve un string de stop-reason si se excede un hard cap
 * (deadline de wall-clock) o un cap de presupuesto best-effort (porcentaje de
 * context-usage); si no, undefined. Se chequea ANTES de rearmar para que un loop
 * nunca programe otra iteración después de un cap. maxIterations sigue siendo un
 * gate separado dentro de fireWake (sin cambios desde P0).
 */
export function capExceeded(ctx: ExtensionContext, loop: LoopCapsInput): string | undefined {
	// NOTE (limitación aceptada): elapsed es WALL-CLOCK (Date.now() - startedAt), no un
	// reloj monotónico. Esto es deliberado: el deadline debe sobrevivir reinicios del
	// proceso ("6h desde que arrancó el loop"), algo que un reloj monotónico por proceso
	// no puede hacer. Un salto hacia atrás del reloj (NTP/DST) solo retrasa este soft cap
	// por la magnitud del salto; el gate maxIterations independiente del reloj (fireWake)
	// sigue siendo el respaldo duro y monotónico.
	const elapsed = Date.now() - loop.startedAt;
	if (loop.maxWallClockMs > 0 && elapsed >= loop.maxWallClockMs) {
		return `alcanzó el deadline de wall-clock (${Math.round(loop.maxWallClockMs / 60000)}m)`;
	}
	// De mejor esfuerzo: getContextUsage puede no estar disponible (undefined) o ser desconocido (percent null).
	const usage = ctx.getContextUsage?.();
	if (usage && usage.percent !== null && usage.percent >= loop.contextPercentCap) {
		return `alcanzó el presupuesto de contexto (${Math.round(usage.percent)}% ≥ ${loop.contextPercentCap}%)`;
	}
	return undefined;
}
