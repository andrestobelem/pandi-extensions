#!/usr/bin/env node
/**
 * Behavioral contract for the dashboard's shared Markdown viewer (markdown-view.ts):
 * a self-contained viewer built on pi-tui's `Markdown` component (NOT importing pi-mdview
 * at runtime, per the self-contained-extension rule), used to show run views / agent views
 * / .md artifacts as RENDERED Markdown instead of a plain text editor dump.
 *
 * Pins:
 *   1. `pickViewerForPath` routes .md/.markdown → "markdown", everything else → "text".
 *   2. `WorkflowMarkdownViewComponent` renders heading + body text and a `q/Esc close` hint,
 *      scrolls, and (when enabled) advertises an `f` files affordance + signals "openFiles".
 *   3. `showMarkdown` in print mode emits the content via console.log and opens no UI.
 *
 * Built with REAL deps (no stubs) like the pi-mdview suite, so the actual Markdown renderer
 * runs and we can assert real rendered output.
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExtension, createChecker, loadModule } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

const { check, counts } = createChecker();

function makeTheme() {
	const id = (t) => t;
	return {
		fg: (_c, t) => t,
		bg: (_c, t) => t,
		bold: id,
		italic: id,
		underline: id,
		inverse: id,
		strikethrough: id,
	};
}

function makeTui(rows = 24, width = 80) {
	return {
		terminal: { columns: width, rows },
		requestRender() {},
	};
}

async function main() {
	const { url } = await buildExtension({
		name: "pi-dwf-markdown-view",
		src: path.join(REPO_ROOT, "extensions", "pi-dynamic-workflows", "markdown-view.ts"),
		outName: "markdown-view.mjs",
		npx: "--no-install",
	});
	const mod = await loadModule(url);
	const { pickViewerForPath, WorkflowMarkdownViewComponent, showMarkdown } = mod;

	// 1) pickViewerForPath
	check("pickViewerForPath is exported", typeof pickViewerForPath === "function");
	check("'.md' → markdown", pickViewerForPath("agent-1/output.md") === "markdown");
	check("'.markdown' → markdown", pickViewerForPath("notes.markdown") === "markdown");
	check("uppercase '.MD' → markdown", pickViewerForPath("README.MD") === "markdown");
	check("'.log' → text", pickViewerForPath("agent-1/stdout.log") === "text");
	check("no extension → text", pickViewerForPath("events") === "text");

	// 2) component renders rendered Markdown + chrome
	check("WorkflowMarkdownViewComponent is exported", typeof WorkflowMarkdownViewComponent === "function");
	let intent;
	const comp = new WorkflowMarkdownViewComponent(
		makeTui(),
		makeTheme(),
		"Workflow run: run-abc",
		"# Hello Heading\n\nSome body text here.",
		(value) => {
			intent = value;
		},
		true, // canOpenFiles
	);
	const rendered = comp.render(80).join("\n");
	check("renders the heading text", /Hello Heading/.test(rendered), rendered);
	check("renders the body text", /Some body text here\./.test(rendered), rendered);
	check("shows q/Esc close hint", /q\/Esc close/i.test(rendered) || /q\/esc/i.test(rendered), rendered);
	check("advertises the files affordance when enabled", /files/i.test(rendered), rendered);

	// scroll changes the visible window (long content + small terminal so it overflows)
	const longBody = `# Hello Heading\n\n${Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n")}`;
	const scroller = new WorkflowMarkdownViewComponent(makeTui(8), makeTheme(), "t", longBody, () => {}, false);
	const before = scroller.render(80).join("\n");
	scroller.handleInput("G"); // jump to end
	const after = scroller.render(80).join("\n");
	check("scroll input changes the rendered window or position", before !== after, "G should change view");

	// `f` signals openFiles; `q` closes
	comp.handleInput("f");
	check("'f' signals openFiles intent", intent === "openFiles", JSON.stringify(intent));
	comp.handleInput("q");
	check("'q' closes (no special intent)", intent === undefined, JSON.stringify(intent));

	// files affordance hidden when disabled
	const noFiles = new WorkflowMarkdownViewComponent(makeTui(), makeTheme(), "t", "# x\n\nbody", () => {}, false)
		.render(80)
		.join("\n");
	check("files affordance hidden when disabled", !/f files|f open|open file/i.test(noFiles), noFiles);

	// 3) showMarkdown print mode
	check("showMarkdown is exported", typeof showMarkdown === "function");
	const logged = [];
	const origLog = console.log;
	console.log = (...a) => logged.push(a.join(" "));
	let customOpened = 0;
	const printCtx = {
		mode: "print",
		hasUI: false,
		ui: {
			custom: async () => {
				customOpened++;
			},
		},
	};
	const ret = await showMarkdown(printCtx, "title", "# Print Heading\n\nprint body");
	console.log = origLog;
	check("print mode emits content via console.log", logged.join("\n").includes("Print Heading"), logged.join("\n"));
	check("print mode opens no custom UI", customOpened === 0, String(customOpened));
	check("print mode returns undefined intent", ret === undefined, JSON.stringify(ret));

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
