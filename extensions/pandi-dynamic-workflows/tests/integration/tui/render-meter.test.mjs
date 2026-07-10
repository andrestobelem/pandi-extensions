#!/usr/bin/env node
/**
 * Test de contrato conductual para `renderMeter` — una barra pura, width-aware, de progreso/
 * utilización, usada para convertir los contadores numéricos densos del tab Monitor
 * (agents done/started, parallel running/limit) en una barra unicode leíble de un vistazo.
 *
 * Contrato fijado acá:
 *   - 0 → todos glyphs empty; 1 → todos glyphs filled; 0.5 → mitad/mitad al width dado.
 *   - Fracciones fuera de rango y no finitas clampean a [0, 1] (nunca throw, nunca overflow).
 *   - El output SIEMPRE tiene exactamente `width` glyphs de ancho (filled + empty), así las columnas alinean.
 *   - `paint.fill` / `paint.empty` opcionales envuelven solo sus segmentos respectivos, para que
 *     el caller pueda pintar la barra en dos tonos con colores de theme sin que el helper conozca el theme.
 *
 * Esta es la primitive visual; `dashboard-monitor-meters.test.mjs` fija que Monitor
 * efectivamente renderiza una.
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExtension, createChecker, loadModule } from "../../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..", "..");

const { check, counts } = createChecker();

const FILLED = "█";
const EMPTY = "░";

async function main() {
	const { url } = await buildExtension({
		name: "pi-dwf-render-meter",
		src: path.join(REPO_ROOT, "extensions", "pandi-dynamic-workflows", "tui/render-utils.ts"),
		outName: "render-utils.mjs",
		stubs: { tui: true },
	});
	const { renderMeter } = await loadModule(url);
	check("renderMeter is exported", typeof renderMeter === "function");

	// Extremos.
	check("0 → all empty", renderMeter(0, 10) === EMPTY.repeat(10), JSON.stringify(renderMeter(0, 10)));
	check("1 → all filled", renderMeter(1, 10) === FILLED.repeat(10), JSON.stringify(renderMeter(1, 10)));
	check(
		"0.5 → half filled at width 10",
		renderMeter(0.5, 10) === FILLED.repeat(5) + EMPTY.repeat(5),
		JSON.stringify(renderMeter(0.5, 10)),
	);

	// Clamping: nunca throwea, nunca desborda el width pedido.
	for (const [frac, label] of [
		[-1, "negative"],
		[2, "above 1"],
		[Number.NaN, "NaN"],
		[Number.POSITIVE_INFINITY, "Infinity"],
	]) {
		const bar = renderMeter(frac, 8);
		check(`${label} fraction stays exactly 8 glyphs`, [...bar].length === 8, JSON.stringify(bar));
	}
	check("negative clamps to empty", renderMeter(-5, 6) === EMPTY.repeat(6));
	check("above-1 clamps to full", renderMeter(5, 6) === FILLED.repeat(6));
	check("NaN clamps to empty", renderMeter(Number.NaN, 6) === EMPTY.repeat(6));

	// El width siempre es exactamente `width` glyphs (filled + empty), para cualquier fracción en rango.
	for (const frac of [0, 0.1, 0.33, 0.5, 0.66, 0.9, 1]) {
		const bar = renderMeter(frac, 12);
		check(`width is exactly 12 for fraction ${frac}`, [...bar].length === 12, JSON.stringify(bar));
	}

	// Los hooks de paint envuelven solo su propio segmento, en orden, sin cambiar el conteo de glyphs.
	const painted = renderMeter(0.5, 4, { fill: (s) => `<f>${s}</f>`, empty: (s) => `<e>${s}</e>` });
	check(
		"paint.fill/empty wrap their own segments in order",
		painted === `<f>${FILLED.repeat(2)}</f><e>${EMPTY.repeat(2)}</e>`,
		JSON.stringify(painted),
	);

	if (counts.failed > 0) {
		console.error("\nFailures:");
		for (const failure of counts.failures) console.error(`- ${failure}`);
		process.exit(1);
	}
	console.log(`\n${counts.passed} checks passed`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
