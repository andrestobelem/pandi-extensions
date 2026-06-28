/**
 * Behavior: when dynamic_workflow is invoked with `input` delivered as a JSON
 * STRING (which happens through the tool-call path), the workflow must receive a
 * PARSED object, not the raw string. Otherwise `input?.limit`/`input?.concurrency`
 * etc. are silently undefined and the workflow uses defaults without warning
 * (observed in a real run: input.json held "{\"limit\": 3}" and the limit was
 * ignored). Object inputs must still pass through unchanged.
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
function check(label, cond, detail) {
	if (cond) { passed += 1; console.log(`PASS: ${label}`); }
	else { failed += 1; console.log(`FAIL: ${label}${detail ? `  [${String(detail).slice(0, 200)}]` : ""}`); }
}

async function buildExtension() {
	const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-dwf-input-coercion-"));
	const typeboxStub = path.join(outDir, "stub-typebox.mjs");
	await fs.writeFile(typeboxStub, "const id = (x) => x ?? {};\nexport const Type = { Object: id, Number: id, String: id, Boolean: id, Array: id, Optional: id, Union: id, Literal: id, Any: id, Integer: id };\nexport default { Type };\n");
	const typeboxValueStub = path.join(outDir, "stub-typebox-value.mjs");
	await fs.writeFile(typeboxValueStub, "export const Value = { Check: () => true, Errors: function* () {} };\nexport default { Value };\n");
	const sdkStub = path.join(outDir, "stub-sdk.mjs");
	await fs.writeFile(sdkStub, `export const CONFIG_DIR_NAME = ".pi";\nexport function getAgentDir() { return ${JSON.stringify(path.join(outDir, "agentdir"))}; }\nexport class CustomEditor { constructor() {} input() {} render() { return []; } }\n`);
	const aiStub = path.join(outDir, "stub-ai.mjs");
	await fs.writeFile(aiStub, "export function StringEnum(values, opts = {}) { return { ...opts, enum: values }; }\n");
	const tuiStub = path.join(outDir, "stub-tui.mjs");
	await fs.writeFile(tuiStub, `export class Image { constructor() {} input() {} render() { return []; } }\nexport const Key = { escape: "escape", enter: "enter", up: "up", down: "down", pageUp: "pageUp", pageDown: "pageDown", home: "home", end: "end", delete: "delete", backspace: "backspace", tab: "tab", left: "left", right: "right", ctrlAlt: (key) => "ctrlAlt:" + key };\nexport function getCapabilities() { return { images: false }; }\nexport function matchesKey(data, key) { return data === key; }\nexport function truncateToWidth(value, width, suffix = "") { const s = String(value); return s.length > width ? s.slice(0, Math.max(0, width - suffix.length)) + suffix : s; }\nexport function visibleWidth(value) { return String(value).length; }\n`);
	const src = path.join(REPO_ROOT, "extensions", "pi-dynamic-workflows", "index.ts");
	if (!existsSync(src)) throw new Error(`missing source: ${src}`);
	const out = path.join(outDir, "dynamic-workflows.mjs");
	const r = spawnSync("npx", ["--yes", "esbuild", src, "--bundle", "--platform=node", "--format=esm", `--alias:typebox=${typeboxStub}`, `--alias:typebox/value=${typeboxValueStub}`, `--alias:@earendil-works/pi-coding-agent=${sdkStub}`, `--alias:@earendil-works/pi-ai=${aiStub}`, `--alias:@earendil-works/pi-tui=${tuiStub}`, `--outfile=${out}`], { cwd: REPO_ROOT, encoding: "utf8" });
	if (r.status !== 0) throw new Error(`esbuild failed: ${r.stderr || r.stdout}`);
	return { url: pathToFileURL(out).href };
}

function makePi() {
	const tools = new Map();
	const pi = {
		registerTool: (def) => tools.set(def.name, def),
		registerCommand: () => {}, registerShortcut: () => {}, on: () => {},
		appendEntry: () => {}, sendUserMessage: () => {}, getThinkingLevel: () => undefined,
		getActiveTools: () => [], getAllTools: () => [...tools.values()], setActiveTools: () => {},
		exec: async () => ({ code: 0, killed: false, stdout: "", stderr: "" }),
	};
	return { pi, tools };
}

function makeCtx(cwd) {
	return {
		mode: "print", hasUI: false, cwd, isIdle: () => true, isProjectTrusted: () => true,
		getContextUsage: () => undefined,
		ui: { theme: { fg: (_c, v) => v }, notify: () => {}, setStatus: () => {}, setWidget: () => {}, confirm: async () => true, select: async () => undefined, editor: async (_t, i = "") => i, custom: async () => undefined, getEditorComponent: () => undefined, setEditorComponent: () => {} },
		sessionManager: { getEntries: () => [] },
	};
}

async function makeProject() {
	const project = await fs.mkdtemp(path.join(os.tmpdir(), "pi-dwf-input-project-"));
	await fs.mkdir(path.join(project, ".pi", "workflows"), { recursive: true });
	// A trivial workflow that just echoes back the input it received.
	await fs.writeFile(
		path.join(project, ".pi", "workflows", "echo-input.js"),
		"module.exports = async function workflow(ctx, input) {\n  return { typeofInput: typeof ctx.input, input: ctx.input };\n};\n",
		"utf8",
	);
	return project;
}

async function runTool(tool, ctx, params) {
	return await tool.execute("tc-input", params, new AbortController().signal, undefined, ctx);
}

const { url } = await buildExtension();
const mod = await import(url);
const ext = mod.default;
const project = await makeProject();
const { pi, tools } = makePi();
(ext.activate ?? ext)(pi, makeCtx(project));
const tool = tools.get("dynamic_workflow");
const ctx = makeCtx(project);

// 1) input delivered as a JSON STRING -> workflow receives a parsed object.
{
	const res = await runTool(tool, ctx, { action: "run", name: "echo-input", input: '{"limit": 3, "concurrency": 2}', timeoutMs: 30_000 });
	const out = res.details.result.output;
	check("string JSON input: run succeeds", res.details.result.ok === true, res.details.result.error);
	check("string JSON input: workflow sees an object, not a string", out?.typeofInput === "object", JSON.stringify(out));
	check("string JSON input: fields are accessible (limit=3)", out?.input?.limit === 3, JSON.stringify(out));
	check("string JSON input: fields are accessible (concurrency=2)", out?.input?.concurrency === 2, JSON.stringify(out));
}

// 2) input delivered as an OBJECT -> passed through unchanged (no regression).
{
	const res = await runTool(tool, ctx, { action: "run", name: "echo-input", input: { limit: 5 }, timeoutMs: 30_000 });
	const out = res.details.result.output;
	check("object input: workflow still sees an object", out?.typeofInput === "object", JSON.stringify(out));
	check("object input: fields preserved (limit=5)", out?.input?.limit === 5, JSON.stringify(out));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
