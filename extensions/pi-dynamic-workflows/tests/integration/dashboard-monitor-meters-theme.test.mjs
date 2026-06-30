#!/usr/bin/env node
/**
 * Theme-awareness regression for the Monitor meters (dark / light / auto).
 *
 * The dashboard never picks raw ANSI/hex colors itself: it paints through the active
 * theme's semantic tokens (`theme.fg("accent"|"success"|"muted", …)`), and pi resolves
 * those per active background — including `auto`, which flips dark↔light at render time.
 * So the meters adapt automatically AS LONG AS their glyphs flow through theme.fg and are
 * never hardcoded.
 *
 * This pins exactly that, so a future edit can't regress light/auto by inlining a color:
 *   - The filled run (█) of the agents progress meter is wrapped by the `success` token.
 *   - The filled run (█) of the parallel utilization meter is wrapped by the `accent` token.
 *   - The empty run (░) of both is wrapped by the `muted` token.
 *   - No meter glyph (█/░) is ever emitted OUTSIDE a theme token wrapper.
 *
 * We assert it with a token-tagging theme that brackets every fg() call, and run it for a
 * "dark" and a "light" tag namespace to prove the SAME code path is used either way.
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExtension, createChecker, loadModule } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

const { check, counts } = createChecker();

const WIDTH = 10000;

// A theme whose fg() brackets its output with the token name, so the test can see which
// semantic token painted each glyph. `ns` namespaces the tags so we can prove the dark and
// light renders take the identical (token-based) path.
function taggingTheme(ns) {
	return { fg: (token, v) => `⟦${ns}:${token}⟧${v}⟦/${ns}:${token}⟧`, bg: (_t, v) => v, bold: (v) => v };
}

function makeAgent() {
	return { id: 1, name: "scout", state: "running", elapsedMs: 4200, promptAvailable: true };
}

function makeRun() {
	const now = Date.now();
	return {
		workflow: "flow-a",
		scope: "project",
		file: "/nonexistent/x.js",
		runId: "run-aaaaaaaaaaaa",
		runDir: "/tmp/nonexistent-run-dir",
		ok: true,
		state: "running",
		startedAt: new Date(now - 60000).toISOString(),
		elapsedMs: 60000,
		agentCount: 8,
		agentConcurrency: 4,
		parallelAgents: 2,
		peakParallelAgents: 3,
		logs: [],
	};
}

function makeMonitorModel(run, agent) {
	return {
		run,
		workflow: run.workflow,
		runId: run.runId,
		state: "running",
		active: true,
		stale: false,
		elapsedMs: 60000,
		agentsStarted: 8,
		agentsDone: 3,
		parallelAgents: 2,
		peakParallelAgents: 3,
		agentConcurrency: 4,
		bashDone: 0,
		artifactCount: 1,
		agents: [agent],
		runDir: run.runDir,
		priority: "active",
		canCancel: true,
		canRerun: false,
	};
}

let WorkflowDashboard;

function renderWith(ns) {
	const run = makeRun();
	const agent = makeAgent();
	const d = new WorkflowDashboard(
		[],
		[run],
		[],
		[],
		[makeMonitorModel(run, agent)],
		[{ run, agent }],
		taggingTheme(ns),
		() => {},
		() => {},
		"monitor",
	);
	return d.render(WIDTH);
}

// True iff every meter glyph (█ / ░) in the string sits INSIDE a ⟦ns:token⟧…⟦/ns:token⟧ wrapper.
function everyMeterGlyphIsTokenWrapped(s, ns) {
	// Strip all token-wrapped spans, then assert no bare meter glyph remains.
	const stripped = s.replace(new RegExp(`⟦${ns}:[a-z]+⟧[\\s\\S]*?⟦/${ns}:[a-z]+⟧`, "g"), "");
	return !/[█░]/.test(stripped);
}

async function main() {
	const { url } = await buildExtension({
		name: "pi-dwf-monitor-meters-theme",
		src: path.join(REPO_ROOT, "extensions", "pi-dynamic-workflows", "workflow-dashboard.ts"),
		outName: "workflow-dashboard.mjs",
		stubs: { typebox: true, typeboxValue: true, ai: true, tui: true, sdk: (dir) => dir && "" },
		npx: "--yes",
	});
	({ WorkflowDashboard } = await loadModule(url));

	for (const ns of ["dark", "light"]) {
		const lines = renderWith(ns);
		const agentsLine = lines.find((l) => l.includes("done/started"));
		// The detail `parallel:` label is the line with both the running count and the peak
		// suffix (the agent ROW also says "running" but never carries "peak:"). The label prefix
		// itself is token-wrapped, so we can't match on a leading "parallel:".
		const parallelLine = lines.find((l) => l.includes("running") && l.includes("peak:3"));

		check(`[${ns}] agents line exists`, typeof agentsLine === "string", JSON.stringify(agentsLine));
		check(`[${ns}] parallel line exists`, typeof parallelLine === "string", JSON.stringify(parallelLine));

		// Filled run painted by the expected semantic token (success for progress, accent for util).
		check(
			`[${ns}] agents filled glyphs use the success token`,
			new RegExp(`⟦${ns}:success⟧█+⟦/${ns}:success⟧`).test(agentsLine ?? ""),
			JSON.stringify(agentsLine),
		);
		check(
			`[${ns}] parallel filled glyphs use the accent token`,
			new RegExp(`⟦${ns}:accent⟧█+⟦/${ns}:accent⟧`).test(parallelLine ?? ""),
			JSON.stringify(parallelLine),
		);
		// Empty run painted by the muted token on both meters.
		check(
			`[${ns}] agents empty glyphs use the muted token`,
			new RegExp(`⟦${ns}:muted⟧░+⟦/${ns}:muted⟧`).test(agentsLine ?? ""),
			JSON.stringify(agentsLine),
		);
		check(
			`[${ns}] parallel empty glyphs use the muted token`,
			new RegExp(`⟦${ns}:muted⟧░+⟦/${ns}:muted⟧`).test(parallelLine ?? ""),
			JSON.stringify(parallelLine),
		);

		// The hard guarantee: NO meter glyph is ever emitted outside a theme token wrapper,
		// so there is no hardcoded color that could break light/auto.
		check(
			`[${ns}] no meter glyph is emitted outside a theme token`,
			everyMeterGlyphIsTokenWrapped(agentsLine ?? "", ns) && everyMeterGlyphIsTokenWrapped(parallelLine ?? "", ns),
			`agents=${JSON.stringify(agentsLine)} parallel=${JSON.stringify(parallelLine)}`,
		);
	}

	// The two namespaces are structurally identical except for the ns tag → same code path,
	// proving dark/light/auto all render through the same token-based meters.
	const darkShape = renderWith("dark")
		.find((l) => l.includes("done/started"))
		?.replace(/dark:/g, "X:");
	const lightShape = renderWith("light")
		.find((l) => l.includes("done/started"))
		?.replace(/light:/g, "X:");
	check("dark and light agents lines are structurally identical", darkShape === lightShape, `${darkShape}`);

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
