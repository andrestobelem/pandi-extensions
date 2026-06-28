/**
 * Durable behavioral integration test proving a dynamic workflow can decide, PER
 * CALL, which model/provider to use and with which thinking (reasoning) level to
 * launch each subagent.
 *
 * This pins the user-facing contract:
 *   - ctx.agent(prompt, { model, thinking })   -> spawns `pi --model <m> --thinking <t>`.
 *   - ctx.agent(prompt, { provider, thinking }) -> spawns `pi --provider <p> --thinking <t>`
 *                                                  WITHOUT a --model (provider-only branch).
 *   - ctx.agents([{ prompt, model, thinking }, { prompt }]) -> per-spec model/thinking
 *     override on one branch; the other branch INHERITS the orchestrator model
 *     (ctx.model -> `provider/id`) and the session thinking level
 *     (pi.getThinkingLevel()).
 *
 * Self-bootstrapping: esbuilds the CURRENT extension to a tempdir (never stale),
 * aliasing typebox/SDK/tui to local stubs so it runs with no `npm install`. The
 * agent subprocess boundary is faked via PI_DYNAMIC_WORKFLOWS_PI_COMMAND: a tiny
 * node script that (a) records its full argv to a per-call JSON file keyed by a
 * marker embedded in the prompt and (b) emits one JSON-mode message_update line so
 * the agent result parses. No real model is called.
 *
 * Run it:
 *   node extensions/pi-dynamic-workflows/tests/integration/model-thinking-selection.test.mjs
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExtension as sharedBuildExtension, createChecker, sdkStub } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

// Workflow under test: makes four agent calls with distinct model/thinking intent.
// Each prompt carries a CALL_* marker the fake `pi` uses to name its argv record.
const WORKFLOW = [
	"module.exports = async function workflow(ctx, input) {",
	"  const a = await ctx.agent('CALL_A scout', { name: 'a', model: 'test-prov/model-a', thinking: 'high', tools: ['read'] });",
	"  const b = await ctx.agent('CALL_B classify', { name: 'b', provider: 'test-prov', thinking: 'low', tools: ['read'] });",
	"  const c = await ctx.agents([",
	"    { name: 'c1', prompt: 'CALL_C1 synth', model: 'test-prov/model-c1', thinking: 'xhigh', tools: ['read'] },",
	"    { name: 'c2', prompt: 'CALL_C2 inherit', tools: ['read'] },",
	"  ], { concurrency: 2 });",
	"  return { a: a.output, b: b.output, c: c.map((r) => (r ? r.output : null)) };",
	"};",
	"",
].join("\n");

const { check, counts } = createChecker();

async function buildExtension() {
	return await sharedBuildExtension({
		name: "pi-model-thinking-integration",
		src: path.join(REPO_ROOT, "extensions", "pi-dynamic-workflows", "index.ts"),
		outName: "dynamic-workflows.mjs",
		stubs: {
			typebox: true,
			typeboxValue: true,
			ai: true,
			tui: true,
			sdk: (dir) => sdkStub(dir, { customEditor: "render" }),
		},
		npx: "--yes",
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
		// Session thinking level the workflow should INHERIT when a call omits `thinking`.
		getThinkingLevel: () => "medium",
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
		// Orchestrator model the workflow should INHERIT when a call omits model/provider.
		model: { provider: "ctx-prov", id: "ctx-model" },
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
	const project = await fs.mkdtemp(path.join(os.tmpdir(), "pi-model-thinking-project-"));
	await fs.mkdir(path.join(project, ".pi", "workflows"), { recursive: true });
	return project;
}

async function runTool(tool, ctx, params) {
	return await tool.execute("tc-integration", params, new AbortController().signal, undefined, ctx);
}

// Fake `pi` agent subprocess. Records its full argv to <RECORD_DIR>/<marker>.json,
// where <marker> is the CALL_* token from the prompt (last argv), then emits one
// JSON-mode message_update so the agent result parses.
async function writeFakePi(outDir, recordDir) {
	const fakePi = path.join(outDir, `fake-pi-${instance}.mjs`);
	await fs.writeFile(
		fakePi,
		`#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
const argv = process.argv.slice(2);
const prompt = argv[argv.length - 1] || "";
const m = /CALL_[A-Z0-9]+/.exec(prompt);
const marker = m ? m[0] : "UNKNOWN-" + Date.now();
fs.writeFileSync(path.join(${JSON.stringify(recordDir)}, marker + ".json"), JSON.stringify(argv));
process.stdout.write(JSON.stringify({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "ok:" + marker }] } }) + "\\n");
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

function flagValue(args, flag) {
	const i = args.indexOf(flag);
	return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}
function hasFlag(args, flag) {
	return args.includes(flag);
}

async function main() {
	try {
		const { outDir, url } = await buildExtension();
		const recordDir = path.join(outDir, "argv");
		await fs.mkdir(recordDir, { recursive: true });
		const project = await makeProject();
		await fs.writeFile(path.join(project, ".pi", "workflows", "model-thinking.js"), WORKFLOW, "utf8");
		const fakePi = await writeFakePi(outDir, recordDir);

		const result = await withFakePi(fakePi, async () => {
			const ext = await freshExtension(url);
			const { pi, tools } = makePi();
			ext(pi);
			const ctx = makeCtx(project);
			const response = await runTool(tools.get("dynamic_workflow"), ctx, {
				action: "run",
				name: "model-thinking",
				input: {},
				maxAgents: 20,
				concurrency: 2,
				timeoutMs: 60_000,
			});
			return response.details.result;
		});

		check("workflow run succeeds", result.ok === true, result.error);
		if (result.ok !== true) {
			finish();
			return;
		}

		const readArgv = async (marker) => JSON.parse(await fs.readFile(path.join(recordDir, `${marker}.json`), "utf8"));

		// CALL_A: explicit model + thinking win.
		const a = await readArgv("CALL_A");
		check("A: explicit model passed as --model", flagValue(a, "--model") === "test-prov/model-a", JSON.stringify(a));
		check("A: explicit thinking passed as --thinking", flagValue(a, "--thinking") === "high", JSON.stringify(a));

		// CALL_B: provider-only branch -> --provider set, NO --model synthesized.
		const b = await readArgv("CALL_B");
		check("B: explicit provider passed as --provider", flagValue(b, "--provider") === "test-prov", JSON.stringify(b));
		check("B: provider-only call omits --model", hasFlag(b, "--model") === false, JSON.stringify(b));
		check("B: explicit thinking passed as --thinking", flagValue(b, "--thinking") === "low", JSON.stringify(b));

		// CALL_C1: per-spec override inside ctx.agents().
		const c1 = await readArgv("CALL_C1");
		check("C1: per-spec model passed as --model", flagValue(c1, "--model") === "test-prov/model-c1", JSON.stringify(c1));
		check("C1: per-spec thinking passed as --thinking", flagValue(c1, "--thinking") === "xhigh", JSON.stringify(c1));

		// CALL_C2: inherits ctx model + session thinking when omitted.
		const c2 = await readArgv("CALL_C2");
		check("C2: inherits orchestrator model (ctx.model -> provider/id)", flagValue(c2, "--model") === "ctx-prov/ctx-model", JSON.stringify(c2));
		check("C2: inherits session thinking level (getThinkingLevel)", flagValue(c2, "--thinking") === "medium", JSON.stringify(c2));

		finish();
	} catch (err) {
		console.error(err instanceof Error ? err.stack || err.message : err);
		process.exit(2);
	}
}

function finish() {
	console.log(`\nTOTAL: ${counts.passed} passed, ${counts.failed} failed`);
	if (counts.failed) {
		console.log(counts.failures.map((f) => `- ${f}`).join("\n"));
		process.exit(1);
	}
	process.exit(0);
}

await main();
