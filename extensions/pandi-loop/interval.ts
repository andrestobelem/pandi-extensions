/**
 * Helpers puros de intervalos de pandi-loop: parsean tokens como "5m" y formatean
 * duraciones para prompts/status sin depender del runtime.
 */

// El modo fijo pertenece al usuario, no al modelo: permite cadencias sub-60s, pero
// rechaza cero y clampa períodos absurdamente largos.
export const MIN_FIXED_INTERVAL_SECONDS = 1;
export const MAX_FIXED_INTERVAL_SECONDS = 24 * 60 * 60; // 24h.
export const INTERVAL_RE = /^(\d+)(s|m|h)$/;

export const INTERVAL_UNIT_MS: Record<string, number> = {
	s: 1000,
	m: 60 * 1000,
	h: 60 * 60 * 1000,
};

/** Parsea un token de intervalo fijo, o null si no tiene forma ^\d+(s|m|h)$. */
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

/** Formatea un período en ms (p. ej. de LoopState.intervalMs) vía formatInterval. */
export function formatLoopInterval(intervalMs: number | undefined): string {
	return formatInterval(Math.round((intervalMs ?? 0) / 1000));
}
