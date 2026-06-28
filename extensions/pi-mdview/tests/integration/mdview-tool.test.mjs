#!/usr/bin/env node
/**
 * Durable behavioral integration test for the model-callable `view_markdown` TOOL
 * registered by extensions/pi-mdview/index.ts.
 *
 * Why this exists: `/mdview` is a user COMMAND (the agent cannot invoke it). To let
 * the agent itself "show a Markdown file", the extension also exposes a TOOL the LLM
 * can call. This suite pins that contract:
 * - the tool is registered with a `path` parameter and a Markdown-aware description
 * - in TUI mode it opens the same custom scroll viewer and returns a short ack
 * - in non-interactive modes it returns the file's Markdown content (no UI opened)
 * - missing/oversized/empty paths return a bounded tool error (details.isError), no UI
 *
 * Self-bootstrapping (same pattern as mdview-extension.test.mjs): it esbuilds the
 * CURRENT extensions/pi-mdview/index.ts into an OS temp dir at run time so it can never
 * test a stale bundle, then drives the REAL registered tool.
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
		src: path.join(REPO_ROOT, "extensions", "pi-mdview", "index.ts"),
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
	check("view_markdown tool registered", !!tool, String(!!tool));
	check("view_markdown describes Markdown", /markdown/i.test(tool?.description || ""), tool?.description);
	const props = tool?.parameters?.properties || {};
	check("view_markdown has a `path` parameter", "path" in props, JSON.stringify(Object.keys(props)));
	check("view_markdown execute is a function", typeof tool?.execute === "function");
}

async function scenarioTuiOpensViewer(url) {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-mdview-tool-tui-"));
	await fs.writeFile(path.join(cwd, "doc.md"), "# Tool Heading\n\nViewer body text\n", "utf8");
	const tool = await loadTool(url);
	const ctx = makeCtx({ cwd, mode: "tui", rows: 10, width: 72 });

	const result = await tool.execute("call-1", { path: "doc.md" }, undefined, undefined, ctx);
	check("tui: opens the custom viewer exactly once", ctx._customCalls.length === 1, String(ctx._customCalls.length));
	const rendered = stripAnsi((ctx._customCalls[0]?.firstRender || []).join("\n"));
	check("tui: viewer renders the heading", /Tool Heading/.test(rendered), rendered);
	const text = result?.content?.[0]?.text || "";
	check("tui: returns an ack mentioning the viewer", /viewer/i.test(text), text);
	check("tui: ack mentions the relative path", /doc\.md/.test(text), text);
	check("tui: details.opened is true", result?.details?.opened === true, JSON.stringify(result?.details));
	check("tui: not an error", !result?.details?.isError, JSON.stringify(result?.details));
}

async function scenarioNonTuiReturnsContent(url) {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-mdview-tool-print-"));
	await fs.writeFile(path.join(cwd, "doc.md"), "# Print Heading\n\nUNIQUE_BODY_42\n", "utf8");
	const tool = await loadTool(url);
	const ctx = makeCtx({ cwd, mode: "print" });

	const result = await tool.execute("call-2", { path: "doc.md" }, undefined, undefined, ctx);
	check("non-tui: opens no viewer", ctx._customCalls.length === 0, String(ctx._customCalls.length));
	const text = result?.content?.[0]?.text || "";
	check("non-tui: returns the document content", text.includes("UNIQUE_BODY_42"), text.slice(0, 120));
	check("non-tui: details.opened is false", result?.details?.opened === false, JSON.stringify(result?.details));
}

async function scenarioMissingFile(url) {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-mdview-tool-missing-"));
	const tool = await loadTool(url);
	const ctx = makeCtx({ cwd, mode: "tui" });

	const result = await tool.execute("call-3", { path: "missing.md" }, undefined, undefined, ctx);
	check("missing: opens no viewer", ctx._customCalls.length === 0, String(ctx._customCalls.length));
	check("missing: returns a tool error", result?.details?.isError === true, JSON.stringify(result?.details));
	check(
		"missing: error mentions read failure",
		/could not read/i.test(result?.content?.[0]?.text || ""),
		result?.content?.[0]?.text,
	);
}

async function scenarioOversized(url) {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-mdview-tool-large-"));
	await fs.writeFile(path.join(cwd, "big.md"), `# Big\n${"x".repeat(3_000_000)}\n`, "utf8");
	const tool = await loadTool(url);
	const ctx = makeCtx({ cwd, mode: "tui" });

	const result = await tool.execute("call-4", { path: "big.md" }, undefined, undefined, ctx);
	check("oversized: opens no viewer", ctx._customCalls.length === 0, String(ctx._customCalls.length));
	check("oversized: returns a tool error", result?.details?.isError === true, JSON.stringify(result?.details));
	check(
		"oversized: error mentions size limit",
		/too large/i.test(result?.content?.[0]?.text || ""),
		result?.content?.[0]?.text,
	);
}

async function scenarioEmptyPath(url) {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-mdview-tool-empty-"));
	const tool = await loadTool(url);
	const ctx = makeCtx({ cwd, mode: "tui" });

	const result = await tool.execute("call-5", { path: "" }, undefined, undefined, ctx);
	check("empty: opens no viewer", ctx._customCalls.length === 0, String(ctx._customCalls.length));
	check("empty: returns a tool error", result?.details?.isError === true, JSON.stringify(result?.details));
}

async function main() {
	const { outDir, url } = await buildMdview();
	try {
		await scenarioRegistered(url);
		await scenarioTuiOpensViewer(url);
		await scenarioNonTuiReturnsContent(url);
		await scenarioMissingFile(url);
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
