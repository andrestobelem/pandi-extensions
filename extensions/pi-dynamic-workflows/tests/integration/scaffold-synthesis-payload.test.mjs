/**
 * Behavior: fan-out -> synthesis scaffolds must NOT feed raw ctx.agents() result
 * objects into ctx.compact(). Each AgentResult carries heavy fields (prompt,
 * stdout, stderr, tools, extensions, ...) far larger than its `.output` text, so
 * compacting the raw array burns the char budget on metadata and silently
 * truncates later branches' actual content before the synthesis judge reads it
 * (observed in a real run: reviews.json was 409 KB while the two outputs were
 * ~10 KB combined, and the judge reported "only branch 1's output survived").
 *
 * Contract: the synthesis step must compact a PROJECTION that includes each
 * branch's `output` (and ideally its `name`), not the bare `completed*` array.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

async function buildExtension() {
	const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-dwf-scaffold-payload-"));
	const typeboxStub = path.join(outDir, "stub-typebox.mjs");
	await fs.writeFile(typeboxStub, "const id = (x) => x ?? {};\nexport const Type = { Object: id, Number: id, String: id, Boolean: id, Array: id, Optional: id, Union: id, Literal: id, Any: id, Integer: id };\nexport default { Type };\n");
	const typeboxValueStub = path.join(outDir, "stub-typebox-value.mjs");
	await fs.writeFile(typeboxValueStub, "export const Value = { Check: () => true, Errors: function* () {} };\nexport default { Value };\n");
	const sdkStub = path.join(outDir, "stub-sdk.mjs");
	await fs.writeFile(sdkStub, `export const CONFIG_DIR_NAME = ".pi";\nexport function getAgentDir() { return ${JSON.stringify(path.join(outDir, "agentdir"))}; }\nexport class CustomEditor { constructor() {} getText() { return ""; } setText() {} handleInput() {} render() { return []; } invalidate() {} }\n`);
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

function makeCtx() {
	return { mode: "tui", hasUI: true, cwd: REPO_ROOT, isProjectTrusted: () => true, ui: { theme: { fg: (_c, v) => v } } };
}

let failures = 0;
function check(name, ok, detail) {
	console.log(`${ok ? "PASS" : "FAIL"}: ${name}`);
	if (!ok) { failures++; if (detail) console.log("   -> " + String(detail).slice(0, 300)); }
}

// scaffold key -> the raw filtered-results identifier it currently compacts.
const FAN_OUT_SYNTHESIS = {
	"fan-out-and-synthesize": "completedReviews",
	"complex-research": "completedResearch",
	"bug-hunt-repo-audit": "completedReviews",
	"plan-review": "completedCritiques",
};

const { url } = await buildExtension();
const mod = await import(url);
const ext = mod.default;

const tools = new Map();
const pi = {
	events: { on: () => {} }, on: () => {}, registerTool: (d) => tools.set(d.name, d),
	registerCommand: () => {}, registerShortcut: () => {}, appendEntry: () => {},
	sendUserMessage: () => {}, getThinkingLevel: () => "medium", setThinkingLevel: () => {},
	getActiveTools: () => [], getAllTools: () => [...tools.values()], setActiveTools: () => {},
	exec: async () => ({ code: 0, killed: false, stdout: "", stderr: "" }),
};
const activate = ext.activate ?? ext;
await activate(pi, makeCtx());
const tool = tools.get("dynamic_workflow");
if (!tool) throw new Error("dynamic_workflow tool not registered");

const signal = new AbortController().signal;
const ctx = makeCtx();

for (const [key, rawVar] of Object.entries(FAN_OUT_SYNTHESIS)) {
	const res = await tool.execute("scaffold", { action: "template", name: key }, signal, () => {}, ctx);
	const code = res?.content?.[0]?.text ?? "";

	// 1) Must NOT compact the bare raw-results array (metadata footgun).
	const rawCompact = new RegExp(`ctx\\.compact\\(\\s*${rawVar}\\s*,`);
	check(`${key}: does not compact raw ${rawVar} array`, !rawCompact.test(code), code.match(rawCompact)?.[0]);

	// 2) Must project to textual output before compacting (attribution-friendly).
	const projects = /\.map\(\s*\(?\s*r\s*\)?\s*=>\s*\(\{[^}]*\boutput:\s*r\.output\b/.test(code);
	check(`${key}: projects results to {..., output: r.output} for synthesis`, projects, code.slice(0, 0));
}

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAIL"}`);
process.exit(failures === 0 ? 0 : 1);
