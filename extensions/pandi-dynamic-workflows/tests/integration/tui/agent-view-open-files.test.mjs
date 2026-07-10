#!/usr/bin/env node
/**
 * Behavioral contract for the artifact-open affordance on the live AGENT view.
 *
 * The agent view (opened with Enter/o from the Agents/Monitor tabs) is the agent's dedicated
 * screen. To make navigation "fit together" with the run view, it now supports the same `f`
 * affordance: when enabled it advertises "f archivos" and pressing `f` signals an "openFiles"
 * intent (the opener then lets the user pick a run artifact and routes it to the right
 * viewer), while `q`/Esc still closes with no intent. When disabled, `f` is inert.
 *
 * Built with the shared stubs (the body renders through the stubbed pi-tui Markdown).
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExtension, createChecker, loadModule } from "../../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..", "..");

const { check, counts } = createChecker();

function makeTheme() {
	const id = (t) => t;
	return { fg: (_c, t) => t, bg: (_c, t) => t, bold: id, italic: id, underline: id, inverse: id, strikethrough: id };
}

async function main() {
	const { url } = await buildExtension({
		name: "pi-dwf-agent-open-files",
		src: path.join(REPO_ROOT, "extensions", "pandi-dynamic-workflows", "tui/agent-live-view.ts"),
		outName: "agent-live-view.mjs",
		stubs: { typebox: true, typeboxValue: true, ai: true, tui: true, sdk: (dir) => dir && "" },
	});
	const { AgentLiveViewComponent } = await loadModule(url);
	check("AgentLiveViewComponent is exported", typeof AgentLiveViewComponent === "function");

	// Enabled: advertises files + `f` signals openFiles, `q` closes plainly.
	let intent = "UNSET";
	const enabled = new AgentLiveViewComponent(
		makeTheme(),
		() => 24,
		(value) => {
			intent = value;
		},
		() => {},
		true, // canOpenFiles
	);
	enabled.setContent("# Agent Heading\n\nthe body", "running");
	const renderedEnabled = enabled.render(80).join("\n");
	check("enabled view advertises the files affordance", /f archivos/i.test(renderedEnabled), renderedEnabled);
	check("enabled view still renders the body", /Agent Heading/.test(renderedEnabled), renderedEnabled);

	enabled.handleInput("f");
	check("'f' signals openFiles when enabled", intent === "openFiles", JSON.stringify(intent));
	intent = "UNSET";
	enabled.handleInput("q");
	check("'q' closes with no intent (undefined)", intent === undefined, JSON.stringify(intent));

	// Disabled: no files hint, `f` is inert (never closes).
	let closedIntent = "UNSET";
	const disabled = new AgentLiveViewComponent(
		makeTheme(),
		() => 24,
		(value) => {
			closedIntent = value;
		},
		() => {},
		false,
	);
	disabled.setContent("# H\n\nbody", "completed");
	const renderedDisabled = disabled.render(80).join("\n");
	check("disabled view hides the files affordance", !/f archivos/i.test(renderedDisabled), renderedDisabled);
	disabled.handleInput("f");
	check("'f' is inert when disabled (no close)", closedIntent === "UNSET", JSON.stringify(closedIntent));

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
