/**
 * Durable behavioral e2e proving the COMPOSITION example is resolvable + coherent.
 *
 * It runs the REAL extension (extensions/dynamic-workflows.ts) over the REAL example
 * files (examples/workflows/composition-rank-driver.js + examples/workflows/lib/
 * rank-candidates.js), copied into a temp project's .pi/workflows/ exactly the way the
 * file headers tell users to lay them out. This pins:
 *   - ctx.workflow("lib/rank-candidates", ...) RESOLVES from .pi/workflows/lib/ (the
 *     documented layout) and the parent->child composition runs in one shared run.
 *   - The lib/ contract is coherent: { candidates, goal } -> { ranked (best-first),
 *     best, dropped, coverage }, with best === ranked[0] and dropped for unscorable.
 *   - The driver delegates ranking via ctx.workflow and emits the sub-workflow
 *     start/end events for "lib/rank-candidates".
 *   - NEGATIVE control: if the lib/ directory is flattened (rank-candidates.js placed
 *     at the workflow root instead of under lib/), ctx.workflow("lib/rank-candidates")
 *     does NOT resolve -> proving the header's lib/ instruction is load-bearing, not
 *     decorative.
 *
 * Self-bootstrapping: esbuilds the CURRENT extension to a tempdir (never stale),
 * aliasing typebox/SDK/tui to local stubs so it runs with no `npm install`. The agent
 * subprocess boundary is faked via PI_DYNAMIC_WORKFLOWS_PI_COMMAND (a tiny node script
 * that emits one JSON-mode `message_update` line), so no model is called.
 *
 * Run it:
 *   node examples/e2e/composition-rank.e2e.mjs
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const EXAMPLES = path.join(REPO_ROOT, "examples", "workflows");

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

async function buildExtension() {
	const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-comp-rank-e2e-"));

	const typeboxStub = path.join(outDir, "stub-typebox.mjs");
	await fs.writeFile(
		typeboxStub,
		"const id = (x) => x ?? {};\nexport const Type = { Object: id, Number: id, String: id, Boolean: id, Array: id, Optional: id, Union: id, Literal: id, Any: id, Integer: id };\nexport default { Type };\n",
	);
	const typeboxValueStub = path.join(outDir, "stub-typebox-value.mjs");
	await fs.writeFile(typeboxValueStub, "export const Value = { Check: () => true, Errors: function* () {} };\nexport default { Value };\n");
	const sdkStub = path.join(outDir, "stub-sdk.mjs");
	await fs.writeFile(
		sdkStub,
		`export const CONFIG_DIR_NAME = ".pi";\nexport function getAgentDir() { return ${JSON.stringify(path.join(outDir, "agentdir"))}; }\nexport class CustomEditor { constructor() {} input() {} render() { return []; } }\n`,
	);
	const aiStub = path.join(outDir, "stub-ai.mjs");
	await fs.writeFile(aiStub, "export function StringEnum(values, opts = {}) { return { ...opts, enum: values }; }\n");
	const tuiStub = path.join(outDir, "stub-tui.mjs");
	await fs.writeFile(
		tuiStub,
		`export class Image { constructor() {} input() {} render() { return []; } }\nexport const Key = { escape: "escape", enter: "enter", up: "up", down: "down", pageUp: "pageUp", pageDown: "pageDown", home: "home", end: "end", delete: "delete", backspace: "backspace", tab: "tab", left: "left", right: "right", ctrlAlt: (key) => "ctrlAlt:" + key };\nexport function getCapabilities() { return { images: false }; }\nexport function matchesKey(data, key) { return data === key; }\nexport function truncateToWidth(value, width, suffix = "") { const s = String(value); return s.length > width ? s.slice(0, Math.max(0, width - suffix.length)) + suffix : s; }\nexport function visibleWidth(value) { return String(value).length; }\n`,
	);

	const src = path.join(REPO_ROOT, "extensions", "dynamic-workflows.ts");
	if (!existsSync(src)) throw new Error(`missing source: ${src}`);
	const out = path.join(outDir, "dynamic-workflows.mjs");
	const r = spawnSync(
		"npx",
		[
			"--yes",
			"esbuild",
			src,
			"--bundle",
			"--platform=node",
			"--format=esm",
			`--alias:typebox=${typeboxStub}`,
			`--alias:typebox/value=${typeboxValueStub}`,
			`--alias:@earendil-works/pi-coding-agent=${sdkStub}`,
			`--alias:@earendil-works/pi-ai=${aiStub}`,
			`--alias:@earendil-works/pi-tui=${tuiStub}`,
			`--outfile=${out}`,
		],
		{ cwd: REPO_ROOT, encoding: "utf8" },
	);
	if (r.status !== 0) throw new Error(`esbuild failed: ${r.stderr || r.stdout}`);
	return { outDir, url: pathToFileURL(out).href };
}

let instance = 0;
async function freshExtension(url) {
	const mod = await import(`${url}?i=${instance++}`);
	return mod.default;
}

function makePi() {
	const tools = new Map();
	const commands = new Map();
	const handlers = new Map();
	const shortcuts = [];
	const activeTools = [];
	const pi = {
		registerTool: (def) => tools.set(def.name, def),
		registerCommand: (name, opts) => commands.set(name, opts),
		registerShortcut: (key, opts) => shortcuts.push({ key, opts }),
		on: (event, handler) => {
			if (!handlers.has(event)) handlers.set(event, []);
			handlers.get(event).push(handler);
		},
		appendEntry: () => {},
		sendUserMessage: () => {},
		getThinkingLevel: () => undefined,
		getActiveTools: () => activeTools,
		getAllTools: () => [...tools.values()],
		setActiveTools: (next) => {
			activeTools.splice(0, activeTools.length, ...next);
		},
		exec: async () => ({ code: 0, killed: false, stdout: "", stderr: "" }),
	};
	return { pi, tools, commands, handlers, shortcuts };
}

function makeCtx(cwd) {
	const theme = { fg: (_color, value) => value };
	return {
		mode: "print",
		hasUI: false,
		cwd,
		isIdle: () => true,
		isProjectTrusted: () => true,
		getContextUsage: () => undefined,
		ui: {
			theme,
			notify: () => {},
			setStatus: () => {},
			setWidget: () => {},
			confirm: async () => true,
			select: async () => undefined,
			editor: async (_title, initial = "") => initial,
			custom: async () => undefined,
			getEditorComponent: () => undefined,
			setEditorComponent: () => {},
		},
		sessionManager: { getEntries: () => [] },
	};
}

async function makeProject() {
	const project = await fs.mkdtemp(path.join(os.tmpdir(), "pi-comp-rank-project-"));
	await fs.mkdir(path.join(project, ".pi", "workflows", "lib"), { recursive: true });
	return project;
}

// Copy the REAL example files into the project's workflow dir, preserving lib/.
async function installRealExamples(project, { flattenLib = false } = {}) {
	const driverSrc = path.join(EXAMPLES, "composition-rank-driver.js");
	const libSrc = path.join(EXAMPLES, "lib", "rank-candidates.js");
	if (!existsSync(driverSrc)) throw new Error(`missing example: ${driverSrc}`);
	if (!existsSync(libSrc)) throw new Error(`missing example: ${libSrc}`);
	await fs.copyFile(driverSrc, path.join(project, ".pi", "workflows", "composition-rank-driver.js"));
	const libDest = flattenLib
		? path.join(project, ".pi", "workflows", "rank-candidates.js") // wrong: not under lib/
		: path.join(project, ".pi", "workflows", "lib", "rank-candidates.js");
	await fs.copyFile(libSrc, libDest);
}

async function readJson(file) {
	return JSON.parse(await fs.readFile(file, "utf8"));
}

async function readEvents(runDir) {
	const body = await fs.readFile(path.join(runDir, "events.jsonl"), "utf8");
	return body.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line));
}

async function runTool(tool, ctx, params) {
	return await tool.execute("tc-e2e", params, new AbortController().signal, undefined, ctx);
}

// Fake `pi` agent subprocess. Emits exactly one JSON-mode message_update line whose
// assistant text is the agent's output. It branches on the prompt (last argv):
//   - candidate-generator prompt -> a JSON array of { id, text }
//   - juror prompt               -> a JSON { score, rationale }
//   - anything else (synthesis)  -> prose
// SCORES is a map { candidateText -> score } so the ranking is deterministic.
async function writeFakePi(outDir, scores) {
	const fakePi = path.join(outDir, `fake-pi-${instance}.mjs`);
	const scoreEntries = JSON.stringify(scores);
	await fs.writeFile(
		fakePi,
		`#!/usr/bin/env node
const prompt = process.argv[process.argv.length - 1] || "";
const SCORES = ${scoreEntries};
function emit(text) {
  process.stdout.write(JSON.stringify({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text }] } }) + "\\n");
}
if (/Generate up to/.test(prompt)) {
  const items = Object.keys(SCORES).map((text, i) => ({ id: "c" + (i + 1), text }));
  emit(JSON.stringify(items));
} else if (/You are juror/.test(prompt)) {
  // Find which candidate this juror is scoring by matching its text in the prompt.
  let score = 5;
  for (const [text, value] of Object.entries(SCORES)) {
    if (prompt.includes(text)) { score = value; break; }
  }
  emit(JSON.stringify({ score, rationale: "fake juror rationale" }));
} else {
  emit("The top candidate won on the rubric. (fake synthesis)");
}
`,
		{ mode: 0o700 },
	);
	return fakePi;
}

async function withFakePi(fakePi, fn) {
	const old = process.env.PI_DYNAMIC_WORKFLOWS_PI_COMMAND;
	process.env.PI_DYNAMIC_WORKFLOWS_PI_COMMAND = fakePi;
	try {
		return await fn();
	} finally {
		if (old === undefined) delete process.env.PI_DYNAMIC_WORKFLOWS_PI_COMMAND;
		else process.env.PI_DYNAMIC_WORKFLOWS_PI_COMMAND = old;
	}
}

async function scenarioResolvesAndRanks(url, outDir) {
	const project = await makeProject();
	await installRealExamples(project);
	// Deterministic scores: "Quartz" should win, "Vague" should lose.
	const scores = { Quartz: 9, Mica: 6, Vague: 2 };
	const fakePi = await writeFakePi(outDir, scores);

	const result = await withFakePi(fakePi, async () => {
		const ext = await freshExtension(url);
		const { pi, tools } = makePi();
		ext(pi);
		const ctx = makeCtx(project);
		const response = await runTool(tools.get("dynamic_workflow"), ctx, {
			action: "run",
			name: "composition-rank-driver",
			input: { goal: "name the project", maxCandidates: 6, jurors: 1 },
			maxAgents: 50,
			concurrency: 1,
			timeoutMs: 60_000,
		});
		return response.details.result;
	});

	check("resolve: parent run succeeds", result.ok === true, result.error);
	if (result.ok !== true) return;

	// Ranking artifact written by the parent after delegating to lib/.
	const ranking = await readJson(path.join(result.runDir, "ranking.json"));
	check("coherence: ranked is best-first (Quartz top)", ranking.ranked[0]?.text === "Quartz", JSON.stringify(ranking.ranked.map((r) => [r.text, r.score])));
	check("coherence: best === ranked[0]", ranking.best && ranking.best.text === ranking.ranked[0].text, JSON.stringify(ranking.best));
	check("coherence: lowest score ranked last", ranking.ranked[ranking.ranked.length - 1]?.text === "Vague", JSON.stringify(ranking.ranked.map((r) => r.text)));
	check("coherence: every kept candidate has a numeric score", ranking.ranked.every((r) => typeof r.score === "number" && Number.isFinite(r.score)), JSON.stringify(ranking.ranked));
	check("coherence: coverage reports candidate + juror counts", ranking.coverage && ranking.coverage.candidates === 3 && ranking.coverage.jurors === 1, JSON.stringify(ranking.coverage));

	// The lib/ sub-workflow itself wrote its own artifact into the SAME run dir.
	const libArtifact = await readJson(path.join(result.runDir, "rank-candidates-result.json"));
	check("resolve: lib/rank-candidates artifact lands in shared runDir", libArtifact.best && libArtifact.best.text === "Quartz", JSON.stringify(libArtifact.best));

	// Composition events prove ctx.workflow("lib/rank-candidates") actually ran.
	const events = await readEvents(result.runDir);
	check("resolve: emits sub-workflow start for lib/rank-candidates", events.some((e) => e.type === "workflow" && e.phase === "start" && e.name === "lib/rank-candidates"), "no start event");
	check("resolve: emits sub-workflow end ok for lib/rank-candidates", events.some((e) => e.type === "workflow" && e.phase === "end" && e.name === "lib/rank-candidates" && e.ok === true), "no ok end event");
}

async function scenarioDropsUnscorable(url, outDir) {
	const project = await makeProject();
	await installRealExamples(project);
	// Call the lib/ sub-workflow DIRECTLY via a tiny parent so we can feed it a
	// blank candidate and confirm the dropped/coherence contract without the
	// generator. This still goes through the REAL resolution + composition path.
	await fs.writeFile(
		path.join(project, ".pi", "workflows", "rank-direct.js"),
		`module.exports = async function workflow(ctx, input) {
  return await ctx.workflow("lib/rank-candidates", {
    goal: "g",
    jurors: 1,
    candidates: [{ id: "ok", text: "Solid" }, { id: "blank", text: "   " }],
  });
};
`,
		"utf8",
	);
	const scores = { Solid: 7 };
	const fakePi = await writeFakePi(outDir, scores);

	const result = await withFakePi(fakePi, async () => {
		const ext = await freshExtension(url);
		const { pi, tools } = makePi();
		ext(pi);
		const ctx = makeCtx(project);
		const response = await runTool(tools.get("dynamic_workflow"), ctx, {
			action: "run",
			name: "rank-direct",
			input: {},
			maxAgents: 50,
			concurrency: 1,
			timeoutMs: 60_000,
		});
		return response.details.result;
	});

	check("dropped: direct lib/ call succeeds", result.ok === true, result.error);
	if (result.ok !== true) return;
	const out = result.output;
	check("dropped: blank candidate is dropped, not ranked", out.dropped.some((d) => d.id === "blank") && out.ranked.every((r) => r.id !== "blank"), JSON.stringify(out));
	check("dropped: valid candidate is still ranked + is best", out.best && out.best.id === "ok", JSON.stringify(out.best));
}

async function scenarioFlattenedLibDoesNotResolve(url, outDir) {
	const project = await makeProject();
	await installRealExamples(project, { flattenLib: true }); // lib placed at root, not under lib/
	const scores = { Quartz: 9, Mica: 6 };
	const fakePi = await writeFakePi(outDir, scores);

	// The run must FAIL because ctx.workflow("lib/rank-candidates") cannot resolve
	// when the file is not under lib/. The extension surfaces an unresolvable
	// sub-workflow by THROWING out of the run (not by returning ok:false), so we
	// capture either shape. This is the negative control proving the header's lib/
	// layout instruction is load-bearing.
	let ok;
	let errMessage = "";
	try {
		const result = await withFakePi(fakePi, async () => {
			const ext = await freshExtension(url);
			const { pi, tools } = makePi();
			ext(pi);
			const ctx = makeCtx(project);
			const response = await runTool(tools.get("dynamic_workflow"), ctx, {
				action: "run",
				name: "composition-rank-driver",
				input: { goal: "name the project", jurors: 1 },
				maxAgents: 50,
				concurrency: 1,
				timeoutMs: 60_000,
			});
			return response.details.result;
		});
		ok = result.ok;
		errMessage = String(result.error ?? "");
	} catch (err) {
		ok = false;
		errMessage = err instanceof Error ? err.message : String(err);
	}

	check(
		"negative: flattened lib/ makes the sub-workflow unresolvable (run fails)",
		ok !== true && /lib\/rank-candidates|not found/i.test(errMessage),
		`ok=${ok} error=${errMessage}`,
	);
}

async function main() {
	try {
		const { outDir, url } = await buildExtension();
		await scenarioResolvesAndRanks(url, outDir);
		await scenarioDropsUnscorable(url, outDir);
		await scenarioFlattenedLibDoesNotResolve(url, outDir);
		console.log(`\nTOTAL: ${passed} passed, ${failed} failed`);
		if (failed) {
			console.log(failures.map((f) => `- ${f}`).join("\n"));
			process.exit(1);
		}
		process.exit(0);
	} catch (err) {
		console.error(err instanceof Error ? err.stack || err.message : err);
		process.exit(2);
	}
}

await main();
