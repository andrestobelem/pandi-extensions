#!/usr/bin/env node
/**
 * Caracteriza el sanitizado inline compartido antes de retirar la copia de TUI.
 * La superficie TUI conserva sus exports, pero la implementación vive en lib.
 */

import { createChecker } from "../../../../shared/test/harness.mjs";
import { buildDwfModule } from "../dwf-test-support.mjs";

const { check, counts } = createChecker();

async function main() {
	const { url } = await buildDwfModule({
		name: "pi-dwf-text-sanitize-parity",
		relPath: "tui/render-utils.ts",
		outName: "render-utils.mjs",
	});
	const { renderSafeInline, stripAnsiCodes } = await import(url);

	check("stripAnsiCodes remains exported from TUI", typeof stripAnsiCodes === "function");
	check("renderSafeInline remains exported from TUI", typeof renderSafeInline === "function");
	check("strips ANSI CSI colors", stripAnsiCodes("\x1b[31mred\x1b[0m") === "red");
	check("strips ANSI OSC terminated by BEL", stripAnsiCodes("\x1b]0;secret\x07visible") === "visible");
	check("strips ANSI OSC terminated by ST", stripAnsiCodes("\x1b]0;secret\x1b\\visible") === "visible");
	check("strips C1 CSI colors", stripAnsiCodes("\x9b31mred\x9b0m") === "red");
	check(
		"renderSafeInline removes controls and compacts whitespace",
		renderSafeInline(" \x1b[32mbamboo\x1b[0m\n\tforest\x00  ") === "bamboo forest",
	);
	check("renderSafeInline keeps an empty result empty", renderSafeInline("\x00\t\n") === "");

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
