/**
 * Helpers puros de render de terminal para la UI del monitor de dynamic-workflows:
 * padding derecho consciente del ancho y stripping de secuencias ANSI/control. Sin efectos
 * secundarios y sin dependencia de index.ts (solo las primitivas de ancho de pi-tui),
 * así que este es un módulo hoja que tanto index.ts como los componentes TUI pueden importar
 * sin ciclo ESM.
 *
 * Cuerpos movidos textualmente desde index.ts (preserva comportamiento).
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

// Este módulo matchea deliberadamente secuencias de escape ANSI/control de terminal
// (p. ej. \x1b, \x07) para poder quitarlas. La regla noControlCharactersInRegex
// está desactivada repo-wide en biome.jsonc exactamente por este motivo.

// Renderiza una barra de progreso/utilización de ancho fijo (p. ej. "████████░░░░") para una fracción
// 0..1. Pura y consciente del ancho: el resultado SIEMPRE tiene exactamente `width` glifos para que
// las columnas queden alineadas, las fracciones fuera de rango / no finitas se limitan a [0, 1], y los
// callbacks opcionales `paint.fill` / `paint.empty` envuelven solo su propio segmento para que el
// caller pueda pintar la barra a dos tonos con colores del tema sin que esta hoja conozca el tema.
export function renderMeter(
	fraction: number,
	width = 12,
	paint?: { fill?: (s: string) => string; empty?: (s: string) => string },
): string {
	const safe = Number.isFinite(fraction) ? Math.max(0, Math.min(1, fraction)) : 0;
	const w = Math.max(1, Math.floor(width));
	const filled = Math.round(safe * w);
	const fill = paint?.fill ?? ((s: string) => s);
	const empty = paint?.empty ?? ((s: string) => s);
	return fill("█".repeat(filled)) + empty("░".repeat(w - filled));
}

export function padRightVisible(value: string, width: number): string {
	const maxWidth = Math.max(1, width);
	const truncated = visibleWidth(value) > maxWidth ? truncateToWidth(value, maxWidth, "") : value;
	return truncated + " ".repeat(Math.max(0, maxWidth - visibleWidth(truncated)));
}

export function stripAnsiCodes(value: string): string {
	return value.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "").replace(/(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]/g, "");
}

export function renderSafeInline(value: string): string {
	return value
		.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "")
		.replace(/(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]/g, "")
		.replace(/[\r\n\t]+/g, " ")
		.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, "")
		.replace(/\s+/g, " ")
		.trim();
}
