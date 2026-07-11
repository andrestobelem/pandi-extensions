#!/usr/bin/env node
/**
 * Behavioral test: bare `/workflow` (no argument) opens an interactive selector when the
 * session has a UI, so the user picks a verb from a list instead of memorizing them —
 * the consistent "no args → interactive menu" rule shared by /ultracode-mode, /container
 * and /pandi. "list" is one of the options, so the previous bare default stays reachable.
 *
 * Observable contract (via the exported pure resolver `resolveWorkflowMenu`):
 *   - bare `/workflow` + hasUI  → calls ctx.ui.select once with the standalone verbs and
 *     resolves to the chosen verb token.
 *   - an explicit verb (`/workflow runs`) passes through untouched (no selector).
 *   - headless (no UI) never opens the selector; bare stays "" (→ the list default).
 *   - cancelling the selector resolves to "" (→ list), no crash.
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { createChecker, loadModule } from "../../../../shared/test/harness.mjs";
import { buildDwfExtension } from "../dwf-test-support.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const { check, counts } = createChecker();

async function buildExtension() {
	return await buildDwfExtension({ name: "pi-dwf-workflow-menu-selector", customEditor: "full" });
}

function makeCtx({ hasUI = true, selectResult } = {}) {
	const selectCalls = [];
	return {
		ctx: {
			hasUI,
			ui: {
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

	// bare /workflow + UI → opens selector, resolves to the chosen verb
	{
		const { ctx, selectCalls } = makeCtx({ selectResult: "cleanup — remove stale runs" });
		const out = await mod.resolveWorkflowMenu("", ctx);
		check("bare /workflow + UI opens the selector once", selectCalls.length === 1, `calls=${selectCalls.length}`);
		const items = selectCalls[0]?.items ?? [];
		const has = (v) => items.some((i) => String(i).toLowerCase().startsWith(v));
		check(
			"selector offers the standalone verbs (incl. list)",
			["list", "patterns", "dashboard", "agents", "sessions", "runs", "cleanup"].every(has),
			JSON.stringify(items),
		);
		check("resolves to the chosen verb token", out === "cleanup", String(out));
	}

	// explicit verb → passes through untouched
	{
		const { ctx, selectCalls } = makeCtx({ selectResult: "cleanup" });
		const out = await mod.resolveWorkflowMenu("runs", ctx);
		check("explicit verb bypasses the selector", selectCalls.length === 0 && out === "runs", String(out));
	}

	// headless bare → never opens the selector; stays "" (→ list default)
	{
		const { ctx, selectCalls } = makeCtx({ hasUI: false, selectResult: "cleanup" });
		const out = await mod.resolveWorkflowMenu("", ctx);
		check("headless bare never opens the selector", selectCalls.length === 0, `calls=${selectCalls.length}`);
		check("headless bare stays empty (list default)", out === "", JSON.stringify(out));
	}

	// cancelling the selector → "" (→ list), no crash
	{
		const { ctx } = makeCtx({ selectResult: undefined });
		const out = await mod.resolveWorkflowMenu("", ctx);
		check("cancelling the selector resolves to empty", out === "", JSON.stringify(out));
	}
}

async function main() {
	const { url } = await buildExtension();
	await scenario(url);

	console.log(`\n${counts.passed} passed, ${counts.failed} failed`);
	if (counts.failed > 0) {
		console.error("Failures:");
		for (const failure of counts.failures) console.error(`- ${failure}`);
		process.exit(1);
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
