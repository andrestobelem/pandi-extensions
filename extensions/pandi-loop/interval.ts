/**
 * Capa de intervalos de pandi-loop (pura): parsea un token de intervalo fijo
 * ("5m", "30s", "2h") a un período clampeado en ms, y formatea segundos de
 * vuelta a una etiqueta humana.
 *
 * Extraído verbatim de index.ts (preserva comportamiento). Sin ctx, sin LoopState,
 * sin estado mutable compartido: una hoja autocontenida. Hermano de profundidad uno
 * importado por index.ts vía "./interval.js".
 */

// Límites de intervalo fijo (segundos). El modelo nunca elige estos valores; lo hace el
// usuario vía el token de intervalo, así que el único propósito es sanidad (sin cero /
// sin períodos absurdamente largos).
// DELIBERADO: a diferencia de la cadencia dinámica dirigida por el modelo (loop_schedule,
// clampeada a [60,3600]), el modo fijo pertenece al usuario y permite intencionalmente
// períodos sub-60s (p. ej. `/loop <task> 30s`, pinneado por tests de loop-behavior).
// Una cadencia demasiado ansiosa queda acotada por el cap de iteraciones, el deadline de
// wall-clock de 6h y la serialización FIFO; parseInterval rechaza `0s` y cae a la cadencia
// dinámica (clampeada).
export const MIN_FIXED_INTERVAL_SECONDS = 1;
export const MAX_FIXED_INTERVAL_SECONDS = 24 * 60 * 60; // 24h.
export const INTERVAL_RE = /^(\d+)(s|m|h)$/;

export const INTERVAL_UNIT_MS: Record<string, number> = {
	s: 1000,
	m: 60 * 1000,
	h: 60 * 60 * 1000,
};

/**
 * Parsea un token de intervalo fijo como "5m", "30s", "2h". Devuelve el período en
 * ms, clampeado a [MIN_FIXED_INTERVAL_SECONDS, MAX_FIXED_INTERVAL_SECONDS], o null si
 * el token no matchea ^\d+(s|m|h)$.
 */
export function parseInterval(token: string): number | null {
	const m = INTERVAL_RE.exec(token.trim());
	if (!m) return null;
	const value = Number(m[1]);
	if (!Number.isFinite(value) || value <= 0) return null;
	const unitMs = INTERVAL_UNIT_MS[m[2]];
	const rawSeconds = (value * unitMs) / 1000;
	const seconds = Math.min(MAX_FIXED_INTERVAL_SECONDS, Math.max(MIN_FIXED_INTERVAL_SECONDS, rawSeconds));
	return seconds * 1000;
}

/** Intervalo legible para humanos para prompts/status (p. ej. 90 -> "90s", 120 -> "2m"). */
export function formatInterval(seconds: number): string {
	if (seconds >= 3600 && seconds % 3600 === 0) return `${seconds / 3600}h`;
	if (seconds >= 60 && seconds % 60 === 0) return `${seconds / 60}m`;
	return `${seconds}s`;
}
