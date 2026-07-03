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

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createChecker, sdkStub, buildExtension as sharedBuildExtension } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

const { check, counts } = createChecker();

async function buildExtension() {
	return await sharedBuildExtension({
		name: "pi-comp-rank-integration",
		src: path.join(REPO_ROOT, "extensions", "pi-dynamic-workflows", "index.ts"),
		outName: "dynamic-workflows.mjs",
		stubs: {
			typebox: true,
			typeboxValue: true,
			ai: true,
			tui: true,
			sdk: (dir) => sdkStub(dir, { customEditor: "render" }),
		},
	});
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

// The fixture workflow sources live as real .js files under fixtures/ (prompts as
// template literals, like the global ~/.claude/workflows and our scaffolds/*.js) so
// Biome lints them as code instead of tripping noTemplateCurlyInString on inline
// source strings.
const FIXTURES_DIR = path.join(__dirname, "fixtures");

// Install fixture workflow files into the project's workflow dir, preserving lib/.
async function installCompositionFixtures(project, { flattenLib = false } = {}) {
	const driver = await fs.readFile(path.join(FIXTURES_DIR, "composition-rank-driver.js"), "utf8");
	const lib = await fs.readFile(path.join(FIXTURES_DIR, "rank-candidates.js"), "utf8");
	await fs.writeFile(path.join(project, ".pi", "workflows", "composition-rank-driver.js"), driver, "utf8");
	const libDest = flattenLib
		? path.join(project, ".pi", "workflows", "rank-candidates.js") // wrong: not under lib/
		: path.join(project, ".pi", "workflows", "lib", "rank-candidates.js");
	await fs.writeFile(libDest, lib, "utf8");
}

async function readJson(file) {
	return JSON.parse(await fs.readFile(file, "utf8"));
}

async function readEvents(runDir) {
	const body = await fs.readFile(path.join(runDir, "events.jsonl"), "utf8");
	return body
		.split("\n")
		.filter((line) => line.trim())
		.map((line) => JSON.parse(line));
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
	check(
		"coherence: ranked is best-first (Quartz top)",
		ranking.ranked[0]?.text === "Quartz",
		JSON.stringify(ranking.ranked.map((r) => [r.text, r.score])),
	);
	check(
		"coherence: best === ranked[0]",
		ranking.best && ranking.best.text === ranking.ranked[0].text,
		JSON.stringify(ranking.best),
	);
	check(
		"coherence: lowest score ranked last",
		ranking.ranked[ranking.ranked.length - 1]?.text === "Vague",
		JSON.stringify(ranking.ranked.map((r) => r.text)),
	);
	check(
		"coherence: every kept candidate has a numeric score",
		ranking.ranked.every((r) => typeof r.score === "number" && Number.isFinite(r.score)),
		JSON.stringify(ranking.ranked),
	);
	check(
		"coherence: coverage reports candidate + juror counts",
		ranking.coverage && ranking.coverage.candidates === 3 && ranking.coverage.jurors === 1,
		JSON.stringify(ranking.coverage),
	);

	// The lib/ sub-workflow itself wrote its own artifact into the SAME run dir.
	const libArtifact = await readJson(path.join(result.runDir, "rank-candidates-result.json"));
	check(
		"resolve: lib/rank-candidates artifact lands in shared runDir",
		libArtifact.best && libArtifact.best.text === "Quartz",
		JSON.stringify(libArtifact.best),
	);

	// Composition events prove ctx.workflow("lib/rank-candidates") actually ran.
	const events = await readEvents(result.runDir);
	check(
		"resolve: emits sub-workflow start for lib/rank-candidates",
		events.some((e) => e.type === "workflow" && e.phase === "start" && e.name === "lib/rank-candidates"),
		"no start event",
	);
	check(
		"resolve: emits sub-workflow end ok for lib/rank-candidates",
		events.some(
			(e) => e.type === "workflow" && e.phase === "end" && e.name === "lib/rank-candidates" && e.ok === true,
		),
		"no ok end event",
	);
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
	check(
		"dropped: blank candidate is dropped, not ranked",
		out.dropped.some((d) => d.id === "blank") && out.ranked.every((r) => r.id !== "blank"),
		JSON.stringify(out),
	);
	check(
		"dropped: valid candidate is still ranked + is best",
		out.best && out.best.id === "ok",
		JSON.stringify(out.best),
	);
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
	let errMessage;
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
		console.log(`\nTOTAL: ${counts.passed} passed, ${counts.failed} failed`);
		if (counts.failed) {
			console.log(counts.failures.map((f) => `- ${f}`).join("\n"));
			process.exit(1);
		}
		process.exit(0);
	} catch (err) {
		console.error(err instanceof Error ? err.stack || err.message : err);
		process.exit(2);
	}
}

await main();
