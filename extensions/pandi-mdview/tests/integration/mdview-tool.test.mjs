#!/usr/bin/env node
/**
 * Test de integración conductual durable para la TOOL `view_markdown` invocable por el modelo,
 * registrada por extensions/pandi-mdview/index.ts.
 *
 * Por qué existe: `/mdview` es un COMMAND del usuario (el agente no puede invocarlo). Para que
 * el propio agente "muestre un archivo Markdown", la extensión también expone una TOOL que el LLM
 * puede llamar. Esta suite fija ese contrato:
 * - la herramienta se registra con un parámetro `path` y una descripción consciente de Markdown
 * - en modo TUI abre el mismo visor con scroll personalizado y devuelve un acuse breve
 * - en modos no interactivos devuelve el contenido Markdown del archivo (no se abre UI)
 * - rutas faltantes/sobredimensionadas/vacías devuelven un error de herramienta acotado (details.isError), sin UI
 *
 * Arranque automático (mismo patrón que mdview-extension.test.mjs): hace esbuild del
 * extensions/pandi-mdview/index.ts actual en un directorio temporal del OS en tiempo de ejecución para que nunca
 * pruebe un bundle obsoleto, y luego usa la herramienta real registrada.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExtension, createChecker, loadDefault } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

const { check, counts } = createChecker();

async function buildMdview() {
	return await buildExtension({
		name: "pi-mdview-tool",
		src: path.join(REPO_ROOT, "extensions", "pandi-mdview", "index.ts"),
		outName: "mdview.mjs",
		npx: "--no-install",
	});
}

function stripAnsi(value) {
	return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

function makeTheme() {
	const id = (_color, text) => text;
	return {
		fg: id,
		bg: id,
		bold: (text) => text,
		italic: (text) => text,
		underline: (text) => text,
		inverse: (text) => text,
		strikethrough: (text) => text,
	};
}

function makePi() {
	const commands = new Map();
	const tools = new Map();
	return {
		pi: {
			registerCommand: (name, opts) => commands.set(name, opts),
			registerTool: (tool) => tools.set(tool.name, tool),
		},
		commands,
		tools,
	};
}

function makeCtx({ cwd, mode = "tui", rows = 12, width = 80 } = {}) {
	const notes = [];
	const customCalls = [];
	const theme = makeTheme();
	const tui = {
		terminal: { columns: width, rows },
		renderRequests: 0,
		requestRender() {
			this.renderRequests += 1;
		},
	};
	return {
		mode,
		hasUI: mode === "tui" || mode === "rpc",
		cwd,
		ui: {
			theme,
			notify: (msg, type) => notes.push({ msg, type }),
			custom: async (factory) => {
				const call = { component: undefined, firstRender: undefined };
				customCalls.push(call);
				let closed = false;
				let closeValue;
				const component = await factory(tui, theme, {}, (value) => {
					closed = true;
					closeValue = value;
				});
				call.component = component;
				call.firstRender = component.render(width);
				component.handleInput?.("q");
				if (!closed) throw new Error("mdview component did not close on q");
				return closeValue;
			},
		},
		_notes: notes,
		_customCalls: customCalls,
	};
}

async function loadTool(url) {
	const extension = await loadDefault(url);
	const { pi, tools } = makePi();
	extension(pi);
	return tools.get("view_markdown");
}

async function scenarioRegistered(url) {
	const tool = await loadTool(url);
	check("view_markdown registrada", !!tool, String(!!tool));
	check("view_markdown menciona Markdown", /markdown/i.test(tool?.description || ""), tool?.description);
	const props = tool?.parameters?.properties || {};
	check("view_markdown tiene parámetro `path`", "path" in props, JSON.stringify(Object.keys(props)));
	check("view_markdown execute es una función", typeof tool?.execute === "function");
}

async function scenarioTuiOpensViewer(url) {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-mdview-tool-tui-"));
	await fs.writeFile(path.join(cwd, "doc.md"), "# Tool Heading\n\nViewer body text\n", "utf8");
	const tool = await loadTool(url);
	const ctx = makeCtx({ cwd, mode: "tui", rows: 10, width: 72 });

	const result = await tool.execute("call-1", { path: "doc.md" }, undefined, undefined, ctx);
	check(
		"tui: abre el visor personalizado una sola vez",
		ctx._customCalls.length === 1,
		String(ctx._customCalls.length),
	);
	const rendered = stripAnsi((ctx._customCalls[0]?.firstRender || []).join("\n"));
	check("tui: el visor renderiza el título", /Tool Heading/.test(rendered), rendered);
	const text = result?.content?.[0]?.text || "";
	check("tui: devuelve un acuse que menciona el visor", /visor/i.test(text), text);
	check("tui: el acuse menciona la ruta relativa", /doc\.md/.test(text), text);
	check("tui: details.opened es true", result?.details?.opened === true, JSON.stringify(result?.details));
	check("tui: no es un error", !result?.details?.isError, JSON.stringify(result?.details));
}

async function scenarioNonTuiReturnsContent(url) {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-mdview-tool-print-"));
	await fs.writeFile(path.join(cwd, "doc.md"), "# Print Heading\n\nUNIQUE_BODY_42\n", "utf8");
	const tool = await loadTool(url);
	const ctx = makeCtx({ cwd, mode: "print" });

	const result = await tool.execute("call-2", { path: "doc.md" }, undefined, undefined, ctx);
	check("sin TUI: no abre visor", ctx._customCalls.length === 0, String(ctx._customCalls.length));
	const text = result?.content?.[0]?.text || "";
	check("sin TUI: devuelve el contenido del documento", text.includes("UNIQUE_BODY_42"), text.slice(0, 120));
	check("sin TUI: details.opened es false", result?.details?.opened === false, JSON.stringify(result?.details));
}

async function scenarioMissingFile(url) {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-mdview-tool-missing-"));
	const tool = await loadTool(url);
	const ctx = makeCtx({ cwd, mode: "tui" });

	const result = await tool.execute("call-3", { path: "missing.md" }, undefined, undefined, ctx);
	check("faltante: no abre visor", ctx._customCalls.length === 0, String(ctx._customCalls.length));
	check("faltante: devuelve un error de tool", result?.details?.isError === true, JSON.stringify(result?.details));
	check(
		"faltante: el error menciona la lectura fallida",
		/no se pudo leer/i.test(result?.content?.[0]?.text || ""),
		result?.content?.[0]?.text,
	);
}

async function scenarioRejectsNonMarkdownExtension(url) {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-mdview-tool-non-md-"));
	await fs.writeFile(path.join(cwd, "secret.txt"), "NOT_MARKDOWN_SECRET\n", "utf8");
	const tool = await loadTool(url);
	const ctx = makeCtx({ cwd, mode: "print" });

	const result = await tool.execute("call-non-md", { path: "secret.txt" }, undefined, undefined, ctx);
	check("no Markdown: no abre visor", ctx._customCalls.length === 0, String(ctx._customCalls.length));
	check("no Markdown: devuelve un error de tool", result?.details?.isError === true, JSON.stringify(result?.details));
	check(
		"no Markdown: rechaza por extensión antes de devolver contenido",
		/\.md|\.markdown/i.test(result?.content?.[0]?.text || "") &&
			!/NOT_MARKDOWN_SECRET/.test(result?.content?.[0]?.text || ""),
		result?.content?.[0]?.text,
	);
}

async function scenarioOversized(url) {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-mdview-tool-large-"));
	await fs.writeFile(path.join(cwd, "big.md"), `# Big\n${"x".repeat(3_000_000)}\n`, "utf8");
	const tool = await loadTool(url);
	const ctx = makeCtx({ cwd, mode: "tui" });

	const result = await tool.execute("call-4", { path: "big.md" }, undefined, undefined, ctx);
	check("sobredimensionado: no abre visor", ctx._customCalls.length === 0, String(ctx._customCalls.length));
	check(
		"sobredimensionado: devuelve un error de tool",
		result?.details?.isError === true,
		JSON.stringify(result?.details),
	);
	check(
		"sobredimensionado: el error menciona el límite de tamaño",
		/demasiado grande/i.test(result?.content?.[0]?.text || ""),
		result?.content?.[0]?.text,
	);
}

async function scenarioEmptyPath(url) {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-mdview-tool-empty-"));
	const tool = await loadTool(url);
	const ctx = makeCtx({ cwd, mode: "tui" });

	const result = await tool.execute("call-5", { path: "" }, undefined, undefined, ctx);
	check("vacío: no abre visor", ctx._customCalls.length === 0, String(ctx._customCalls.length));
	check("vacío: devuelve un error de tool", result?.details?.isError === true, JSON.stringify(result?.details));
}

async function main() {
	const { outDir, url } = await buildMdview();
	try {
		await scenarioRegistered(url);
		await scenarioTuiOpensViewer(url);
		await scenarioNonTuiReturnsContent(url);
		await scenarioMissingFile(url);
		await scenarioRejectsNonMarkdownExtension(url);
		await scenarioOversized(url);
		await scenarioEmptyPath(url);
	} finally {
		await fs.rm(outDir, { recursive: true, force: true });
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
