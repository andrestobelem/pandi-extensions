/**
 * Durable behavioral integration test proving ctx.workflow() composition is resolvable + coherent.
 *
 * It installs inline fixture workflows into a temp project's .pi/workflows/ exactly
 * the way runtime composition resolves files: parent at the workflow root, reusable
 * child under lib/. This pins:
 *   - ctx.workflow("lib/rank-candidates", ...) RESOLVES from .pi/workflows/lib/.
 *   - The lib/ contract is coherent: { candidates, goal } -> { ranked, best,
 *     dropped, coverage }, with best === ranked[0] and dropped for unscorable.
 *   - The driver delegates ranking via ctx.workflow and emits sub-workflow
 *     start/end events for "lib/rank-candidates".
 *   - NEGATIVE control: if the lib/ directory is flattened, resolution fails.
 *
 * Self-bootstrapping: esbuilds the CURRENT extension to a tempdir (never stale),
 * aliasing typebox/SDK/tui to local stubs so it runs with no `npm install`. The agent
 * subprocess boundary is faked via PI_DYNAMIC_WORKFLOWS_PI_COMMAND (a tiny node script
 * that emits one JSON-mode `message_update` line), so no model is called.
 *
 * Run it:
 *   node extensions/pi-dynamic-workflows/tests/integration/composition-rank.test.mjs
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const RANK_DRIVER_WORKFLOW = "module.exports = async function workflow(ctx, input) {\n  const goal = input?.goal ?? input?.topic ?? input?.question ?? input?.text;\n  if (!goal) throw new Error('Pass { goal: \"what to generate and rank candidates for\" }.');\n  const maxCandidates = Math.max(2, Number(input?.maxCandidates ?? 6));\n\n  // 1) DISCOVER: generate candidate options for the goal (this is the non-reusable,\n  //    goal-specific part that stays in the parent).\n  const generator = await ctx.agent(\n    `Generate up to ${maxCandidates} distinct, concrete candidate options for the goal below. ` +\n      `Return ONLY a JSON array of { id, text }. Make the options genuinely different from each other.\\n\\n` +\n      `Goal: ${goal}`,\n    { name: \"candidate-generator\", agentType: \"researcher\", tools: [\"read\", \"grep\", \"find\", \"ls\"] },\n  );\n\n  let candidates = [];\n  try {\n    candidates = JSON.parse(generator.output);\n  } catch {\n    candidates = [];\n  }\n  candidates = Array.isArray(candidates)\n    ? candidates.filter((cand) => cand && typeof cand.text === \"string\").slice(0, maxCandidates)\n    : [];\n  if (candidates.length === 0) return \"No candidate options were generated to rank.\";\n  if (candidates.length >= maxCandidates) await ctx.log(\"candidate cap applied\", { generated: candidates.length, maxCandidates });\n  await ctx.writeArtifact(\"candidates.json\", candidates);\n\n  // 2) DELEGATE the reusable ranking phase to the lib/ sub-workflow.\n  //    No human/decision gate sits between discovery and ranking, so composition\n  //    (not a separate run) is the right tool: shared run, budget, and cache.\n  const ranking = await ctx.workflow(\"lib/rank-candidates\", {\n    candidates,\n    goal,\n    rubric: input?.rubric,\n    jurors: input?.jurors ?? 3,\n    keepTop: input?.keepTop,\n  });\n  await ctx.writeArtifact(\"ranking.json\", ranking);\n\n  if (!ranking.best) return \"Ranking produced no scorable candidate.\";\n\n  // 3) SYNTHESIZE: explain the winner using the delegated ranking.\n  const synthesis = await ctx.agent(\n    `Explain why the top-ranked candidate won and how it compares to the runners-up. ` +\n      `Cite the juror scores. Note that ranking was delegated to lib/rank-candidates.\\n\\n` +\n      `${ctx.compact(ranking, 50000)}`,\n    { name: \"rank-synthesis\", agentType: \"reviewer\", tools: [\"read\", \"grep\", \"find\", \"ls\"] },\n  );\n  await ctx.writeArtifact(\"best.md\", synthesis.output);\n  return synthesis.output;\n};\n";
const RANK_CANDIDATES_WORKFLOW = "module.exports = async function workflow(ctx, input) {\n  const raw = Array.isArray(input?.candidates) ? input.candidates : [];\n  const candidates = raw\n    .map((cand, i) => (typeof cand === \"string\" ? { id: `cand-${i}`, text: cand } : cand))\n    .filter((cand) => cand && typeof cand.text === \"string\" && cand.text.trim().length > 0)\n    .map((cand, i) => ({ id: cand.id ?? `cand-${i}`, text: cand.text }));\n  const dropped = raw\n    .map((cand, i) => ({ cand, i }))\n    .filter(({ cand }) => !cand || typeof (typeof cand === \"string\" ? cand : cand.text) !== \"string\" || String(typeof cand === \"string\" ? cand : cand.text).trim().length === 0)\n    .map(({ cand, i }) => ({ id: (cand && cand.id) ?? `cand-${i}`, text: cand && cand.text, reason: \"empty or non-text candidate\" }));\n\n  if (candidates.length === 0) {\n    const empty = { ranked: [], best: null, dropped, coverage: { candidates: 0, jurors: 0, requestedJurors: 0 } };\n    await ctx.writeArtifact(\"rank-candidates-result.json\", empty);\n    return empty;\n  }\n\n  const requestedJurors = Math.max(1, Number(input?.jurors ?? 3));\n  // Never spawn more parallel agents than the run's concurrency budget allows.\n  const jurors = Math.min(requestedJurors, ctx.limits.concurrency);\n  if (jurors < requestedJurors) {\n    await ctx.log(\"juror cap applied\", { requested: requestedJurors, running: jurors, concurrency: ctx.limits.concurrency });\n  }\n\n  const rubric = input?.rubric ?? \"overall quality, clarity, and fitness for the stated goal\";\n  const goal = input?.goal ?? \"n/a\";\n\n  const SCORE = {\n    type: \"object\",\n    additionalProperties: false,\n    required: [\"score\", \"rationale\"],\n    properties: {\n      score: { type: \"number\", description: \"0-10, higher is better\" },\n      rationale: { type: \"string\", description: \"one short sentence justifying the score\" },\n    },\n  };\n\n  const ranked = [];\n  for (let i = 0; i < candidates.length; i++) {\n    const candidate = candidates[i];\n    // Independent jury: each juror scores the candidate against the rubric.\n    // settle:true so one juror erroring/timing-out does not abort the rest.\n    const jury = await ctx.agents(\n      Array.from({ length: jurors }, (_unused, j) => ({\n        name: `rank-${candidate.id}-juror-${j + 1}`,\n        prompt:\n          `You are juror ${j + 1}/${jurors}. Score the candidate below from 0 to 10 against the rubric. ` +\n          `Be calibrated: reserve 9-10 for clearly excellent, 0-3 for clearly poor.\\n\\n` +\n          `Goal: ${goal}\\n` +\n          `Rubric: ${rubric}\\n` +\n          `Candidate: ${candidate.text}\\n\\n` +\n          `Return JSON only matching the schema.`,\n        agentType: \"reviewer\",\n        tools: [\"read\", \"grep\", \"find\", \"ls\"],\n        schema: SCORE,\n        schemaOnInvalid: \"null\",\n      })),\n      { concurrency: jurors, settle: true },\n    );\n    const parsed = jury\n      .filter(Boolean)\n      .map((result) => result.data)\n      .filter((vote) => vote && typeof vote.score === \"number\" && Number.isFinite(vote.score));\n    if (parsed.length === 0) {\n      dropped.push({ id: candidate.id, text: candidate.text, reason: \"no juror returned a valid score\" });\n      await ctx.log(\"candidate unscorable\", { id: candidate.id, failedBranches: jury.length });\n      continue;\n    }\n    // Average juror score; clamp into [0,10] so a stray out-of-range vote cannot dominate.\n    const clamped = parsed.map((vote) => Math.min(10, Math.max(0, vote.score)));\n    const score = clamped.reduce((acc, value) => acc + value, 0) / clamped.length;\n    const rationale = parsed.map((vote) => vote.rationale).filter(Boolean).join(\" | \");\n    ranked.push({ id: candidate.id, text: candidate.text, score, votes: clamped, rationale });\n    await ctx.log(\"candidate scored\", { id: candidate.id, score, jurors: clamped.length, failedBranches: jury.length - parsed.length });\n  }\n\n  // Deterministic best-first order; tie-break by id so the ranking is stable.\n  ranked.sort((a, b) => (b.score - a.score) || String(a.id).localeCompare(String(b.id)));\n\n  const keepTop = Number(input?.keepTop);\n  const finalRanked = Number.isFinite(keepTop) && keepTop > 0 ? ranked.slice(0, keepTop) : ranked;\n\n  // `best` is a SHALLOW COPY of the top entry, not the same object reference, so\n  // serialization (writeArtifact / ctx.compact) does not emit \"[Circular]\" for the\n  // second occurrence of the shared object.\n  const result = {\n    ranked: finalRanked,\n    best: finalRanked[0] ? { ...finalRanked[0] } : null,\n    dropped,\n    coverage: { candidates: candidates.length, jurors, requestedJurors },\n  };\n  await ctx.writeArtifact(\"rank-candidates-result.json\", result);\n  await ctx.log(\"ranking complete\", { ranked: finalRanked.length, dropped: dropped.length, best: result.best?.id ?? null });\n  return result;\n};\n";

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
	const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-comp-rank-integration-"));

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

	const src = path.join(REPO_ROOT, "extensions", "pi-dynamic-workflows", "index.ts");
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

// Install fixture workflow files into the project's workflow dir, preserving lib/.
async function installCompositionFixtures(project, { flattenLib = false } = {}) {
	await fs.writeFile(path.join(project, ".pi", "workflows", "composition-rank-driver.js"), RANK_DRIVER_WORKFLOW, "utf8");
	const libDest = flattenLib
		? path.join(project, ".pi", "workflows", "rank-candidates.js") // wrong: not under lib/
		: path.join(project, ".pi", "workflows", "lib", "rank-candidates.js");
	await fs.writeFile(libDest, RANK_CANDIDATES_WORKFLOW, "utf8");
}

async function readJson(file) {
	return JSON.parse(await fs.readFile(file, "utf8"));
}

async function readEvents(runDir) {
	const body = await fs.readFile(path.join(runDir, "events.jsonl"), "utf8");
	return body.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line));
}

async function runTool(tool, ctx, params) {
	return await tool.execute("tc-integration", params, new AbortController().signal, undefined, ctx);
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
	await installCompositionFixtures(project);
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
	await installCompositionFixtures(project);
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
	await installCompositionFixtures(project, { flattenLib: true }); // lib placed at root, not under lib/
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
