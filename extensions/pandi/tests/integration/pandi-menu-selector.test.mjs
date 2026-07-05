#!/usr/bin/env node
/**
 * Test de comportamiento: `/pandi` pelado (sin argumento) abre un selector interactivo
 * cuando la sesión tiene UI, para que el usuario elija status|on|off|art|face de una lista
 * en vez de memorizarlos: la regla consistente de "sin args → menú interactivo" que
 * comparten /ultracode-mode y /container.
 *
 * Contrato observable (vía el resolver puro exportado `resolvePandiInput`):
 *   - `/pandi` pelado + hasUI → llama ctx.ui.select una vez con status/on/off/art/face y
 *     resuelve al token del subcomando elegido ("status" mapea de vuelta al saludo = "").
 *   - un subcomando explícito (`/pandi on`) pasa intacto (sin selector).
 *   - headless (sin UI) nunca abre el selector; pelado sigue siendo el saludo ("").
 *   - cancelar el selector resuelve a "" (saludo), sin romperse.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExtension, createChecker, loadModule } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

const { check, counts } = createChecker();

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

async function scenario(url) {
	const mod = await loadModule(url);

	// /pandi pelado + UI → abre el selector y resuelve al subcomando elegido
	{
		const { ctx, selectCalls } = makeCtx({ selectResult: "off — mandar a Pandi a dormir" });
		const out = await mod.resolvePandiInput("", ctx);
		check("bare /pandi + UI opens the selector once", selectCalls.length === 1, `calls=${selectCalls.length}`);
		const items = selectCalls[0]?.items ?? [];
		const has = (v) => items.some((i) => String(i).toLowerCase().startsWith(v));
		check(
			"selector offers status / on / off / art / face",
			["status", "on", "off", "art", "face"].every(has),
			JSON.stringify(items),
		);
		check("resolves to the chosen subcommand token", out === "off", String(out));
	}

	// elegir "status" mapea de vuelta al saludo (subcomando vacío)
	{
		const { ctx } = makeCtx({ selectResult: "status — estado + saludo de Pandi" });
		const out = await mod.resolvePandiInput("", ctx);
		check("picking status maps back to the greeting", out === "", JSON.stringify(out));
	}

	// subcomando explícito → pasa intacto
	{
		const { ctx, selectCalls } = makeCtx({ selectResult: "off" });
		const out = await mod.resolvePandiInput("on", ctx);
		check("explicit subcommand bypasses the selector", selectCalls.length === 0 && out === "on", String(out));
	}

	// /pandi pelado en headless → nunca abre el selector; sigue siendo el saludo
	{
		const { ctx, selectCalls } = makeCtx({ hasUI: false, selectResult: "off" });
		const out = await mod.resolvePandiInput("", ctx);
		check("headless bare never opens the selector", selectCalls.length === 0, `calls=${selectCalls.length}`);
		check("headless bare stays the greeting", out === "", JSON.stringify(out));
	}

	// cancelar el selector → "" (saludo), sin romperse
	{
		const { ctx } = makeCtx({ selectResult: undefined });
		const out = await mod.resolvePandiInput("", ctx);
		check("cancelling the selector resolves to empty", out === "", JSON.stringify(out));
	}
}

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

main().catch((error) => {
	console.error(error);
	process.exit(2);
});
