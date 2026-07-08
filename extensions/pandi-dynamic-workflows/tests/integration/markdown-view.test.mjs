#!/usr/bin/env node
/**
 * Contrato de comportamiento para el Markdown viewer compartido del dashboard (markdown-view.ts):
 * un viewer self-contained construido sobre el componente `Markdown` de pi-tui (NO importa pandi-mdview
 * en runtime, por la regla de extensión self-contained), usado para mostrar run views / agent views
 * / artifacts .md como Markdown RENDERED en vez de un dump de editor de texto plano.
 *
 * Pinea:
 *   1. `pickViewerForPath` routea .md/.markdown → "markdown", todo lo demás → "text".
 *   2. `WorkflowMarkdownViewComponent` renderiza heading + body text y un hint `q/Esc cerrar`,
 *      scrollea, y (cuando está habilitado) publicita un affordance `f` archivos + señal "openFiles".
 *   3. `showMarkdown` en modo print emite el contenido vía console.log y no abre UI.
 *
 * Buildeado con deps REALES (sin stubs) como la suite pandi-mdview, así corre el renderer Markdown
 * real y podemos asertar output renderizado real.
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
		src: path.join(REPO_ROOT, "extensions", "pandi-dynamic-workflows", "markdown-view.ts"),
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

	// 2) el componente renderiza Markdown rendered + chrome
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
	check("shows q/Esc close hint", /q\/Esc cerrar/i.test(rendered) || /q\/esc/i.test(rendered), rendered);
	check("advertises the files affordance when enabled", /archivos/i.test(rendered), rendered);

	// scroll cambia la ventana visible (contenido largo + terminal chica para que haya overflow)
	const longBody = `# Hello Heading\n\n${Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n")}`;
	const scroller = new WorkflowMarkdownViewComponent(makeTui(8), makeTheme(), "t", longBody, () => {}, false);
	const before = scroller.render(80).join("\n");
	scroller.handleInput("G"); // saltar al final
	const after = scroller.render(80).join("\n");
	check("scroll input changes the rendered window or position", before !== after, "G should change view");

	// `f` señala openFiles; `q` cierra
	comp.handleInput("f");
	check("'f' signals openFiles intent", intent === "openFiles", JSON.stringify(intent));
	comp.handleInput("q");
	check("'q' closes (no special intent)", intent === undefined, JSON.stringify(intent));

	// affordance de files oculto cuando está deshabilitado
	const noFiles = new WorkflowMarkdownViewComponent(makeTui(), makeTheme(), "t", "# x\n\nbody", () => {}, false)
		.render(80)
		.join("\n");
	check("files affordance hidden when disabled", !/f archivos|f files|f open|open file/i.test(noFiles), noFiles);

	// 3) showMarkdown en modo print
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
