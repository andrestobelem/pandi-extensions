#!/usr/bin/env node
/**
 * Behavioral contract for the shared viewer "chrome" helpers (markdown-view.ts), used by BOTH
 * the run view (WorkflowMarkdownViewComponent) and the live agent view (AgentLiveViewComponent)
 * so their footer/header hint string and scroll-key handling stay identical (one source of
 * truth, intra-extension dedup).
 *
 * Pins:
 *   1. formatViewerHints — the navigation/close/position hint: scroll keys + PgUp/PgDn +
 *      optional "f archivos" + "q/Esc cerrar" + "start-end/total".
 *   2. scrollDelta — maps a key to a scroll action: ±1 (line), ±page, "top"/"bottom", or null.
 *
 * Built with REAL deps so the real matchesKey runs.
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createChecker, loadModule } from "../../../../shared/test/harness.mjs";
import { buildDwfModule } from "../dwf-test-support.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const _REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..", "..");

const { check, counts } = createChecker();

async function main() {
	const { url } = await buildDwfModule({
		name: "pi-dwf-viewer-chrome",
		relPath: "lib/markdown-view.ts",
		outName: "markdown-view.mjs",
		npx: "--no-install",
	});
	const { formatViewerHints, scrollDelta } = await loadModule(url);

	// 1) formatViewerHints
	check("formatViewerHints is exported", typeof formatViewerHints === "function");
	const withFiles = formatViewerHints({ canOpenFiles: true, start: 1, end: 20, total: 100 });
	const noFiles = formatViewerHints({ canOpenFiles: false, start: 1, end: 20, total: 100 });
	check("hint advertises files when enabled", /f archivos/.test(withFiles), withFiles);
	check("hint hides files when disabled", !/f archivos/.test(noFiles), noFiles);
	check("hint shows q/Esc close", /q\/Esc cerrar/.test(withFiles), withFiles);
	check("hint shows position start-end/total", /\b1-20\/100\b/.test(withFiles), withFiles);
	check("hint shows line scroll keys (j/k)", /j\/k/.test(withFiles), withFiles);
	check("hint shows page keys (PgUp/PgDn)", /PgUp\/PgDn/.test(withFiles), withFiles);

	// 2) scrollDelta
	check("scrollDelta is exported", typeof scrollDelta === "function");
	check("'j' scrolls down one line", scrollDelta("j", 10) === 1, String(scrollDelta("j", 10)));
	check("'k' scrolls up one line", scrollDelta("k", 10) === -1, String(scrollDelta("k", 10)));
	check("'g' jumps to top", scrollDelta("g", 10) === "top", String(scrollDelta("g", 10)));
	check("'G' jumps to bottom", scrollDelta("G", 10) === "bottom", String(scrollDelta("G", 10)));
	check("unknown key → null", scrollDelta("z", 10) === null, String(scrollDelta("z", 10)));

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
