#!/usr/bin/env node
/**
 * Caracteriza el resolver de `/pandi` sin argumentos.
 * Con UI abre un selector; sin UI, un subcomando explícito o una cancelación conserva el
 * comportamiento seguro de saludo y nunca intenta abrir un menú inexistente.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExtension, createChecker, loadModule } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

const { check, counts } = createChecker();

async function main() {
	const built = await buildExtension({
		name: "pi-pandi-menu-selector",
		src: path.join(REPO_ROOT, "extensions", "pandi", "index.ts"),
		outName: "pandi.mjs",
		stubs: { sdk: "export {};\n" },
	});
	try {
		await scenario(built.url);
	} finally {
		await fs.rm(built.outDir, { recursive: true, force: true });
	}

	console.log(`\n${counts.passed} passed, ${counts.failed} failed`);
	if (counts.failed) {
		console.log("Failures:");
		for (const failure of counts.failures) console.log(`- ${failure}`);
		process.exit(1);
	}
}

async function scenario(url) {
	const mod = await loadModule(url);

	{
		const { ctx, selectCalls } = makeCtx({ selectResult: "off — mandar a Pandi a dormir" });
		const out = await mod.resolvePandiInput("", ctx);
		check("bare /pandi + UI opens the selector once", selectCalls.length === 1, `calls=${selectCalls.length}`);
		const items = selectCalls[0]?.items ?? [];
		check(
			"selector offers exactly the exported Pandi action labels",
			JSON.stringify(items) === JSON.stringify(mod.PANDI_SELECT_ITEMS),
			JSON.stringify(items),
		);
		check("resolves to the chosen subcommand token", out === "off", String(out));
	}

	{
		const { ctx } = makeCtx({ selectResult: "status — estado + saludo de Pandi" });
		const out = await mod.resolvePandiInput("", ctx);
		check("picking status maps back to the greeting", out === "", JSON.stringify(out));
	}

	{
		const { ctx, selectCalls } = makeCtx({ selectResult: "off" });
		const out = await mod.resolvePandiInput("on", ctx);
		check("explicit subcommand bypasses the selector", selectCalls.length === 0 && out === "on", String(out));
	}

	{
		const { ctx, selectCalls } = makeCtx({ hasUI: false, selectResult: "off" });
		const out = await mod.resolvePandiInput("", ctx);
		check("headless bare never opens the selector", selectCalls.length === 0, `calls=${selectCalls.length}`);
		check("headless bare stays the greeting", out === "", JSON.stringify(out));
	}

	{
		const { ctx } = makeCtx({ selectResult: undefined });
		const out = await mod.resolvePandiInput("", ctx);
		check("cancelling the selector resolves to empty", out === "", JSON.stringify(out));
	}
}

function makeCtx({ hasUI = true, selectResult } = {}) {
	const selectCalls = [];
	return {
		ctx: {
			hasUI,
			ui: {
				theme: { fg: (_c, v) => v, bg: (_c, v) => v, bold: (v) => v },
				select: async (title, items) => {
					selectCalls.push({ title, items });
					return selectResult;
				},
			},
		},
		selectCalls,
	};
}

main().catch((error) => {
	console.error(error);
	process.exit(2);
});
