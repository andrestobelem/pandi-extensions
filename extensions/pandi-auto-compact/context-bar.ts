// Barra de progreso del footer de pandi-auto-compact. La barra mide el avance HACIA el
// umbral de compactación (usage / threshold), así que llega al 100% exactamente cuando
// la auto-compactación está por dispararse — una señal útil de "qué tan cerca estoy" en vez de una
// fracción casi vacía de toda la ventana de contexto. Pura (sin theme/ctx), así que es trivial de
// testear unitariamente; index.ts aplica color según `level` y reexporta renderContextBar
// (+ los tipos de la barra) para la suite de integración.

// Glifos y ancho de la barra de progreso.
const BAR_FILLED = "\u25B0";
const BAR_EMPTY = "\u25B1";
const BAR_WIDTH = 8;
// Por debajo de esta fracción del umbral la barra está calma (verde/success); en ese valor o por encima
// la barra le avisa al usuario que la auto-compactación se está acercando.
const NEAR_RATIO = 0.6;

export type ContextBarLevel = "idle" | "near" | "over" | "compacting";

export interface ContextBar {
	text: string;
	level: ContextBarLevel;
}

const getClampedContextRatio = (percent: number, thresholdPercent: number) => {
	const ratio = thresholdPercent > 0 ? percent / thresholdPercent : 0;
	return { ratio, clamped: Math.max(0, Math.min(1, ratio)) };
};

const getContextBarLevel = (ratio: number, compacting?: boolean): ContextBarLevel => {
	if (compacting) return "compacting";
	return ratio >= 1 ? "over" : ratio >= NEAR_RATIO ? "near" : "idle";
};

const renderContextBarText = (percent: number, thresholdPercent: number, width: number, clampedRatio: number) => {
	const filled = Math.round(clampedRatio * width);
	const bar = BAR_FILLED.repeat(filled) + BAR_EMPTY.repeat(width - filled);
	const label = `${Math.round(percent)}%/${thresholdPercent}%`;
	return `compact ${bar} ${label}`;
};

// Render puro de la barra de progreso del footer. Se mantiene libre de theme/ctx para que sea
// fácil de testear unitariamente; la extensión aplica color según `level`.
// Devuelve null cuando no hay nada con sentido para mostrar (usage desconocido), p. ej.
// justo después de compactar, antes de que la siguiente respuesta del assistant reporte tokens.
export const renderContextBar = (opts: {
	percent: number | null | undefined;
	thresholdPercent: number;
	compacting?: boolean;
	width?: number;
}): ContextBar | null => {
	const width = opts.width ?? BAR_WIDTH;
	if (opts.compacting) {
		return { text: `compact ${BAR_FILLED.repeat(width)} compacting\u2026`, level: getContextBarLevel(0, true) };
	}
	const { percent, thresholdPercent } = opts;
	if (percent === null || percent === undefined || !Number.isFinite(percent)) return null;
	const { ratio, clamped } = getClampedContextRatio(percent, thresholdPercent);
	return {
		text: renderContextBarText(percent, thresholdPercent, width, clamped),
		level: getContextBarLevel(ratio),
	};
};
