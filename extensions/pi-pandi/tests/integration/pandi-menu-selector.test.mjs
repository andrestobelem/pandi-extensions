#!/usr/bin/env node
/**
 * Behavioral test: `/pandi menu` opens an interactive selector (when the session has a
 * UI) so the user can pick on|off|art|face from a list instead of memorizing them.
 *
 * Observable contract (via the exported pure resolver `resolvePandiInput`):
 *   - `/pandi menu` + hasUI  → calls ctx.ui.select once with the on/off/art/face options
 *     and resolves to the chosen subcommand token.
 *   - bare `/pandi` NEVER opens the selector (it keeps its greeting/status).
 *   - an explicit subcommand (`/pandi on`) passes through untouched.
 *   - headless (no UI) never opens the selector.
 *   - cancelling the selector resolves to "" (bare greeting), no crash.
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

	// /pandi menu + UI → opens selector, resolves to the chosen subcommand
	{
		const { ctx, selectCalls } = makeCtx({ selectResult: "off — mandar a Pandi a dormir" });
		const out = await mod.resolvePandiInput("menu", ctx);
		check("/pandi menu + UI opens the selector once", selectCalls.length === 1, `calls=${selectCalls.length}`);
		const items = selectCalls[0]?.items ?? [];
		const has = (v) => items.some((i) => String(i).toLowerCase().startsWith(v));
		check("selector offers on / off / art / face", ["on", "off", "art", "face"].every(has), JSON.stringify(items));
		check("resolves to the chosen subcommand token", out === "off", String(out));
	}

	// bare /pandi → never opens the selector (keeps its greeting)
	{
		const { ctx, selectCalls } = makeCtx({ selectResult: "off" });
		const out = await mod.resolvePandiInput("", ctx);
		check("bare /pandi never opens the selector", selectCalls.length === 0, `calls=${selectCalls.length}`);
		check("bare /pandi passes through empty", out === "", JSON.stringify(out));
	}

	// explicit subcommand → passes through untouched
	{
		const { ctx, selectCalls } = makeCtx({ selectResult: "off" });
		const out = await mod.resolvePandiInput("on", ctx);
		check("explicit subcommand bypasses the selector", selectCalls.length === 0 && out === "on", String(out));
	}

	// headless /pandi menu → never opens the selector
	{
		const { ctx, selectCalls } = makeCtx({ hasUI: false, selectResult: "off" });
		await mod.resolvePandiInput("menu", ctx);
		check("headless /pandi menu never opens the selector", selectCalls.length === 0, `calls=${selectCalls.length}`);
	}

	// cancelling the selector → "" (bare greeting), no crash
	{
		const { ctx } = makeCtx({ selectResult: undefined });
		const out = await mod.resolvePandiInput("menu", ctx);
		check("cancelling the selector resolves to empty", out === "", JSON.stringify(out));
	}
}

async function main() {
	const built = await buildExtension({
		name: "pi-pandi-menu-selector",
		src: path.join(REPO_ROOT, "extensions", "pi-pandi", "index.ts"),
		outName: "pandi.mjs",
		stubs: { sdk: "export {};\n" },
		npx: "--yes",
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
