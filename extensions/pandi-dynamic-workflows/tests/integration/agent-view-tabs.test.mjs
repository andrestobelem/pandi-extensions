#!/usr/bin/env node
/**
 * Behavioral contract for the SUB-TABS on the live agent/run detail view.
 *
 * Entering a run's agent from the Monitor/Agents tabs opens one detail screen with
 * sub-tabs (Card, Prompt, Output, Definition, Run) instead of separate full screens.
 * This pins the component half: the tab bar renders with the active tab highlighted,
 * ←/→ and Tab/Shift+Tab cycle, digits jump, scroll position is remembered PER TAB,
 * switching notifies the opener (so it can load that tab's content immediately), and
 * the legacy single-document mode (no tabs passed) still behaves exactly as before.
 *
 * Built with the shared stubs (the body renders through the stubbed pi-tui Markdown).
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExtension, createChecker, loadModule } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

const { check, counts } = createChecker();

function makeTheme() {
	const id = (t) => t;
	return { fg: (_c, t) => t, bg: (_c, t) => t, bold: id, italic: id, underline: id, inverse: id, strikethrough: id };
}

const TABS = [
	{ key: "card", label: "Card" },
	{ key: "prompt", label: "Prompt" },
	{ key: "definition", label: "Definition" },
];

async function main() {
	const { url } = await buildExtension({
		name: "pi-dwf-agent-view-tabs",
		src: path.join(REPO_ROOT, "extensions", "pandi-dynamic-workflows", "agent-live-view.ts"),
		outName: "agent-live-view.mjs",
		stubs: { typebox: true, typeboxValue: true, ai: true, tui: true, sdk: (dir) => dir && "" },
	});
	const { AgentLiveViewComponent } = await loadModule(url);

	const switched = [];
	const view = new AgentLiveViewComponent(
		makeTheme(),
		() => 12,
		() => {},
		() => {},
		true,
		TABS,
		(key) => switched.push(key),
	);
	check("getActiveTab starts on the first tab", view.getActiveTab() === "card", view.getActiveTab());

	view.setTabContent("card", `# Card body\n${"card-line\n".repeat(40)}`);
	view.setTabContent("prompt", "# Prompt body");
	view.setContent("ignored-state-update", "running");

	let rendered = view.render(80).join("\n");
	check("tab bar highlights the active tab", /\[Card\]/.test(rendered), rendered);
	check("tab bar lists the other tabs", /Prompt/.test(rendered) && /Definition/.test(rendered), rendered);
	check("active tab content renders", /Card body/.test(rendered), rendered);
	check("inactive tab content does not render", !/Prompt body/.test(rendered), rendered);
	check("hints advertise tab switching", /←→ tabs/.test(rendered), rendered);

	// Scroll down on Card, then switch: scroll is remembered per tab.
	view.handleInput("pageDown");
	const scrolledCard = view.render(80).join("\n");
	check("card scrolled away from heading", !/Card body/.test(scrolledCard), scrolledCard);

	view.handleInput("right");
	check("→ moves to the next tab", view.getActiveTab() === "prompt", view.getActiveTab());
	check("tab switch notifies the opener", switched.includes("prompt"), JSON.stringify(switched));
	rendered = view.render(80).join("\n");
	check("prompt tab renders its own content from the top", /Prompt body/.test(rendered), rendered);

	view.handleInput("left");
	check("← moves back", view.getActiveTab() === "card", view.getActiveTab());
	const backOnCard = view.render(80).join("\n");
	check("card scroll position was remembered", !/Card body/.test(backOnCard), backOnCard);

	view.handleInput("tab");
	check("Tab cycles forward", view.getActiveTab() === "prompt", view.getActiveTab());
	view.handleInput("shift+tab");
	check("Shift+Tab cycles backward", view.getActiveTab() === "card", view.getActiveTab());
	view.handleInput("shift+tab");
	check("cycling wraps around", view.getActiveTab() === "definition", view.getActiveTab());

	view.handleInput("2");
	check("digit jumps straight to that tab", view.getActiveTab() === "prompt", view.getActiveTab());

	const empty = view.render(80).join("\n");
	view.handleInput("3");
	check("tab without content renders a loading placeholder", /Loading/.test(view.render(80).join("\n")), empty);

	// Existing affordances keep working in tabs mode.
	let intent = "UNSET";
	const closing = new AgentLiveViewComponent(
		makeTheme(),
		() => 12,
		(value) => {
			intent = value;
		},
		() => {},
		true,
		TABS,
	);
	closing.handleInput("f");
	check("'f' still signals openFiles in tabs mode", intent === "openFiles", JSON.stringify(intent));
	closing.handleInput("q");
	check("'q' still closes in tabs mode", intent === undefined, JSON.stringify(intent));

	// Legacy single-document mode: no tab bar, ←/→ inert, setContent unchanged.
	const legacy = new AgentLiveViewComponent(
		makeTheme(),
		() => 12,
		() => {},
		() => {},
	);
	legacy.setContent("# Solo doc", "running");
	const legacyRendered = legacy.render(80).join("\n");
	check("legacy mode renders content", /Solo doc/.test(legacyRendered), legacyRendered);
	check("legacy mode shows no tab bar", !/\[Card\]|←→ tabs/.test(legacyRendered), legacyRendered);
	legacy.handleInput("right");
	check("legacy mode ignores tab keys", /Solo doc/.test(legacy.render(80).join("\n")));

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
