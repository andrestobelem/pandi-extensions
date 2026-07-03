#!/usr/bin/env node
/**
 * Behavioral contract test for `renderMeter` — a pure, width-aware progress/utilization
 * bar used to turn the Monitor tab's dense numeric counters (agents done/started,
 * parallel running/limit) into an at-a-glance unicode bar.
 *
 * Contract pinned here:
 *   - 0 → all empty glyphs; 1 → all filled glyphs; 0.5 → half/half at the given width.
 *   - Out-of-range and non-finite fractions clamp to [0, 1] (never throw, never overflow).
 *   - The output is ALWAYS exactly `width` glyphs wide (filled + empty), so columns align.
 *   - Optional `paint.fill` / `paint.empty` wrap only their respective segments, so the
 *     caller can two-tone the bar with theme colors without the helper knowing the theme.
 *
 * This is the visual primitive; `dashboard-monitor-meters.test.mjs` pins that the Monitor
 * actually renders one.
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExtension, createChecker, loadModule } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

const { check, counts } = createChecker();

const FILLED = "█";
const EMPTY = "░";

async function main() {
	const { url } = await buildExtension({
		name: "pi-dwf-render-meter",
		src: path.join(REPO_ROOT, "extensions", "pi-dynamic-workflows", "render-utils.ts"),
		outName: "render-utils.mjs",
		stubs: { tui: true },
	});
	const { renderMeter } = await loadModule(url);
	check("renderMeter is exported", typeof renderMeter === "function");

	// Endpoints.
	check("0 → all empty", renderMeter(0, 10) === EMPTY.repeat(10), JSON.stringify(renderMeter(0, 10)));
	check("1 → all filled", renderMeter(1, 10) === FILLED.repeat(10), JSON.stringify(renderMeter(1, 10)));
	check(
		"0.5 → half filled at width 10",
		renderMeter(0.5, 10) === FILLED.repeat(5) + EMPTY.repeat(5),
		JSON.stringify(renderMeter(0.5, 10)),
	);

	// Clamping: never throws, never overflows the requested width.
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

	// Width is always exactly `width` glyphs (filled + empty), for any in-range fraction.
	for (const frac of [0, 0.1, 0.33, 0.5, 0.66, 0.9, 1]) {
		const bar = renderMeter(frac, 12);
		check(`width is exactly 12 for fraction ${frac}`, [...bar].length === 12, JSON.stringify(bar));
	}

	// Paint hooks wrap only their own segment, in order, without changing the glyph count.
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
