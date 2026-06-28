#!/usr/bin/env node
/**
 * Durable behavioral integration test for extensions/pi-mdview/index.ts.
 *
 * Pins the public /mdview contract:
 * - the command is registered by the extension
 * - a relative Markdown file path opens a custom TUI component
 * - quoted paths with spaces are resolved relative to ctx.cwd
 * - q closes the focused viewer
 * - missing arguments/files report bounded UI warnings/errors instead of throwing
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

let passed = 0;
let failed = 0;
const failures = [];
function check(label, cond, detail) {
	if (cond) {
		passed += 1;
		console.log(`PASS: ${label}`);
	} else {
		failed += 1;
		failures.push(label + (detail ? `  [${detail}]` : ""));
		console.log(`FAIL: ${label}${detail ? `  [${detail}]` : ""}`);
	}
}

async function buildMdview() {
	const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-mdview-integration-"));
	const src = path.join(REPO_ROOT, "extensions", "pi-mdview", "index.ts");
	if (!existsSync(src)) throw new Error(`missing source: ${src}`);
	const out = path.join(outDir, "mdview.mjs");
	const r = spawnSync(
		"npx",
		[
			"--no-install",
			"esbuild",
			src,
			"--bundle",
			"--platform=node",
			"--format=esm",
			`--outfile=${out}`,
		],
		{ cwd: REPO_ROOT, encoding: "utf8" },
	);
	if (r.status !== 0) throw new Error(`esbuild failed for mdview: ${r.stderr || r.stdout}`);
	return { outDir, url: pathToFileURL(out).href };
}

let instance = 0;
async function freshDefault(url) {
	const mod = await import(`${url}?i=${instance++}`);
	return mod.default;
}

function makePi() {
	const commands = new Map();
	const tools = new Map();
	return {
		pi: {
			registerCommand: (name, opts) => commands.set(name, opts),
			// The extension also registers a model-callable `view_markdown` tool; this
			// suite only exercises the /mdview COMMAND, so capture tools without asserting.
			registerTool: (tool) => tools.set(tool.name, tool),
		},
		commands,
		tools,
	};
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
	const ctx = {
		mode,
		hasUI: mode !== "print",
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
	};
	ctx._notes = notes;
	ctx._customCalls = customCalls;
	ctx._tui = tui;
	return ctx;
}

async function loadExtension(url) {
	const extension = await freshDefault(url);
	const { pi, commands } = makePi();
	extension(pi);
	return { commands };
}

async function scenarioRegisters(url) {
	const { commands } = await loadExtension(url);
	check("/mdview command registered", commands.has("mdview"));
	check("/mdview has description", /Markdown/i.test(commands.get("mdview")?.description || ""));
}

async function scenarioRendersRelativePath(url) {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-mdview-project-"));
	await fs.writeFile(path.join(cwd, "README.md"), "# Hello Markdown\n\nBody text\n", "utf8");
	const { commands } = await loadExtension(url);
	const ctx = makeCtx({ cwd, rows: 10, width: 72 });

	await commands.get("mdview").handler("README.md", ctx);
	const rendered = stripAnsi(ctx._customCalls[0].firstRender.join("\n"));
	check("/mdview opens custom UI", ctx._customCalls.length === 1, String(ctx._customCalls.length));
	check("/mdview renders heading text", /Hello Markdown/.test(rendered), rendered);
	check("/mdview renders body text", /Body text/.test(rendered), rendered);
	check("/mdview shows close hint", /q\/Esc close/.test(rendered), rendered);
}

async function scenarioQuotedPath(url) {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-mdview-spaces-"));
	await fs.mkdir(path.join(cwd, "docs"));
	await fs.writeFile(path.join(cwd, "docs", "file with spaces.md"), "# Spaced Path\n", "utf8");
	const { commands } = await loadExtension(url);
	const ctx = makeCtx({ cwd });

	await commands.get("mdview").handler('"docs/file with spaces.md"', ctx);
	const rendered = stripAnsi(ctx._customCalls[0].firstRender.join("\n"));
	check("/mdview resolves quoted relative paths", /Spaced Path/.test(rendered), rendered);
}

async function scenarioErrors(url) {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-mdview-errors-"));
	const { commands } = await loadExtension(url);
	const command = commands.get("mdview");

	const noArgCtx = makeCtx({ cwd });
	await command.handler("", noArgCtx);
	check("/mdview missing arg does not open UI", noArgCtx._customCalls.length === 0, String(noArgCtx._customCalls.length));
	check("/mdview missing arg reports usage", /Usage: \/mdview/.test(noArgCtx._notes.at(-1)?.msg || ""));

	const missingCtx = makeCtx({ cwd });
	await command.handler("missing.md", missingCtx);
	check("/mdview missing file does not open UI", missingCtx._customCalls.length === 0, String(missingCtx._customCalls.length));
	check("/mdview missing file reports error", missingCtx._notes.at(-1)?.type === "error", JSON.stringify(missingCtx._notes));
}

async function captureConsole(fn) {
	const out = [];
	const err = [];
	const origLog = console.log;
	const origErr = console.error;
	console.log = (...a) => out.push(a.join(" "));
	console.error = (...a) => err.push(a.join(" "));
	try {
		await fn();
	} finally {
		console.log = origLog;
		console.error = origErr;
	}
	return { out: out.join("\n"), err: err.join("\n") };
}

async function scenarioLargeFileGuard(url) {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-mdview-large-"));
	await fs.writeFile(path.join(cwd, "big.md"), `# Big\n${"x".repeat(3_000_000)}\n`, "utf8");
	const { commands } = await loadExtension(url);
	const ctx = makeCtx({ cwd });
	await commands.get("mdview").handler("big.md", ctx);
	check("large-file: does not open the viewer for an oversized file", ctx._customCalls.length === 0, String(ctx._customCalls.length));
	check("large-file: warns about size", /large/i.test(ctx._notes.at(-1)?.msg || "") && ctx._notes.at(-1)?.type === "warning", JSON.stringify(ctx._notes.at(-1)));
}

async function scenarioPrintModeStdout(url) {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-mdview-print-"));
	await fs.writeFile(path.join(cwd, "doc.md"), "# Heading\n\nplain body\n", "utf8");
	const { commands } = await loadExtension(url);
	const ctx = makeCtx({ cwd, mode: "print" });
	const { out } = await captureConsole(() => commands.get("mdview").handler("doc.md", ctx));
	// Unit-level: the handler emits the document via console.log. Under the real
	// `pi --print` binary that stream is routed to stderr (see scenarioPrintModeRealStdout).
	check("print: emits document content via console.log", out.includes("plain body"), out);
	check("print: opens no custom UI", ctx._customCalls.length === 0, String(ctx._customCalls.length));
}

async function scenarioPrintModeErrorToStderr(url) {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-mdview-print-err-"));
	const { commands } = await loadExtension(url);
	const ctx = makeCtx({ cwd, mode: "print" });
	const { out, err } = await captureConsole(() => commands.get("mdview").handler("missing.md", ctx));
	check("print-error: error goes to stderr, not stdout", /Could not read/.test(err) && !/Could not read/.test(out), JSON.stringify({ out, err }));
}

// End-to-end against the real `pi --print` binary so we exercise pi's stdout
// takeover (it reserves real stdout for the model response and routes all
// extension console output to stderr). A mocked console.log can never reveal
// this, which is exactly why the in-process unit checks gave false confidence.
async function scenarioPrintModeRealStdout() {
	const which = spawnSync("bash", ["-lc", "command -v pi"], { encoding: "utf8" });
	if (which.status !== 0) {
		console.log("SKIP: print-real: `pi` CLI not on PATH");
		return;
	}
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-mdview-print-real-"));
	const docPath = path.join(cwd, "doc.md");
	await fs.writeFile(docPath, "# Heading\n\nUNIQUE_BODY_TOKEN\n", "utf8");
	const extPath = path.join(REPO_ROOT, "extensions", "pi-mdview");
	const r = spawnSync(
		"pi",
		["--no-extensions", "-e", extPath, "--no-session", "--print", `/mdview ${docPath}`],
		{ cwd, encoding: "utf8", timeout: 30000 },
	);
	const stdout = r.stdout || "";
	const stderr = r.stderr || "";
	check("print-real: exits cleanly", r.status === 0, JSON.stringify({ status: r.status, err: stderr.slice(0, 200) }));
	// Honest contract: pi reserves real stdout for the model response, so the
	// document is emitted to the terminal via stderr; `pi /mdview f.md > out.md`
	// captures nothing. These two checks pin that real routing.
	check(
		"print-real: document is emitted to the terminal (stderr)",
		stderr.includes("UNIQUE_BODY_TOKEN"),
		JSON.stringify({ stderrLen: stderr.length }),
	);
	check(
		"print-real: stdout carries no document content (reserved for model output)",
		!stdout.includes("UNIQUE_BODY_TOKEN"),
		JSON.stringify({ stdoutLen: stdout.length }),
	);
}

async function main() {
	const { outDir, url } = await buildMdview();
	try {
		await scenarioRegisters(url);
		await scenarioRendersRelativePath(url);
		await scenarioQuotedPath(url);
		await scenarioErrors(url);
		await scenarioLargeFileGuard(url);
		await scenarioPrintModeStdout(url);
		await scenarioPrintModeErrorToStderr(url);
		await scenarioPrintModeRealStdout();
	} finally {
		await fs.rm(outDir, { recursive: true, force: true });
	}

	console.log(`\n${passed} passed, ${failed} failed`);
	if (failed) {
		console.log("Failures:");
		for (const failure of failures) console.log(`- ${failure}`);
		process.exit(1);
	}
}

main().catch((error) => {
	console.error(error);
	process.exit(2);
});
