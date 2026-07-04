/**
 * Durable behavioral integration test for the FAILURE + RECURSION contracts of ctx.workflow()
 * composition in extensions/pandi-dynamic-workflows/index.ts.
 *
 * The sibling suite (dynamic-workflow-composition.test.mjs) pins the HAPPY-PATH
 * composition contract (shared run/runDir/limits/budget, child-code-hash resume
 * cache, and the NESTED depth-1 guard parent -> child -> grandchild). This suite
 * pins two contracts that the happy-path suite does NOT cover:
 *
 *   1. DIRECT self-recursion is refused with a DISTINCT message. The nested guard
 *      (`composition depth limit is 1: sub-workflows cannot call other sub-workflows`)
 *      only catches parent -> child -> grandchild. A workflow that calls ITSELF via
 *      ctx.workflow("<own name>") never goes a level deeper, so the nested guard
 *      never fires; a separate path-equality check in runSubworkflow refuses it with
 *      `refused recursive call ... may not call their parent`. Without that check a
 *      self-calling workflow recurses until the stack/limits blow — this is the guard
 *      that prevents an infinite run, and it had zero integration coverage.
 *
 *   2. A sub-workflow FAILURE propagates to the parent AS A NORMAL THROW and the run
 *      records a `workflow` `phase:"error"` event (ok:false, with the message). The
 *      happy-path suite only asserts the `phase:"end"`/ok:true event. If a regression
 *      swallowed child errors (returned undefined instead of rethrowing), a parent
 *      would silently continue past a failed sub-step and the run would look "ok"
 *      while a phase never executed. We assert BOTH that the throw is catchable by the
 *      parent (so composition failures are recoverable, not unconditionally fatal) AND
 *      that the error event is recorded for observability even when the parent recovers.
 *
 * Same self-bootstrapping pattern as the other integration tests: esbuild the CURRENT source to a
 * tempdir (never stale), alias typebox/SDK/tui to local stubs (runs without
 * `npm install`), install real workflow files under a temp project's .pi/workflows,
 * and drive the REAL `dynamic_workflow` tool. Assertions are on OBSERVABLE outcomes
 * (run ok/error, recorded events), never copies of the source internals.
 *
 * Run it:
 *   node extensions/pandi-dynamic-workflows/tests/integration/composition-failure-recursion.test.mjs
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { sdkStub, buildExtension as sharedBuildExtension } from "../../../shared/test/harness.mjs";

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

async function buildExtension() {
	return await sharedBuildExtension({
		name: "pi-dwf-fail-integration",
		src: path.join(REPO_ROOT, "extensions", "pandi-dynamic-workflows", "index.ts"),
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

function makePi(execImpl = async () => ({ code: 0, killed: false, stdout: "", stderr: "" })) {
	const tools = new Map();
	const commands = new Map();
	const handlers = new Map();
	const shortcuts = [];
	const activeTools = [];
	const execCalls = [];
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
		exec: async (cmd, args, opts) => {
			execCalls.push({ cmd, args, opts });
			return execImpl(cmd, args, opts, execCalls.length);
		},
	};
	return { pi, tools, commands, handlers, shortcuts, execCalls };
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
	const project = await fs.mkdtemp(path.join(os.tmpdir(), "pi-dwf-fail-project-"));
	await fs.mkdir(path.join(project, ".pi", "workflows"), { recursive: true });
	return project;
}

async function writeWorkflow(project, relativeName, code) {
	const file = path.join(
		project,
		".pi",
		"workflows",
		relativeName.endsWith(".js") ? relativeName : `${relativeName}.js`,
	);
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(file, code, "utf8");
	return file;
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

// action="run" THROWS formatRunSummary(result) when the run fails (it does not
// return { ok:false }). The summary text carries `Artifacts: <runDir>` and
// `Error: <message>`, which is the observable surface the agent/user sees. This
// helper runs a workflow expected to FAIL and returns the parsed failure surface.
async function runExpectingFailure(tool, ctx, params) {
	let message;
	try {
		const ok = await runTool(tool, ctx, params);
		// Should not happen for a failing run; surface the unexpected success.
		return { threw: false, message: "", runDir: undefined, ok };
	} catch (err) {
		message = err instanceof Error ? err.message : String(err);
	}
	const runDirMatch = message.match(/^Artifacts:\s*(.+)$/m);
	const errorMatch = message.match(/^Error:\s*([\s\S]*)$/m);
	return {
		threw: true,
		message,
		runDir: runDirMatch ? runDirMatch[1].trim() : undefined,
		error: errorMatch ? errorMatch[1].trim() : message,
	};
}

// --- Scenario 1: a workflow that calls ITSELF is refused with the DISTINCT
//     "recursive call ... may not call their parent" message (not the nested
//     depth-1 message), and the run fails instead of looping forever. -----------
async function scenarioDirectSelfRecursion(url) {
	const project = await makeProject();
	// The workflow's resolved name (from the .pi/workflows path) is "selfie".
	await writeWorkflow(
		project,
		"selfie",
		`
module.exports = async function workflow(ctx) {
  // Call ourselves: must be refused BEFORE recursing, with the parent-recursion message.
  return await ctx.workflow("selfie", {});
};
`,
	);

	const ext = await freshExtension(url);
	const { pi, tools } = makePi();
	ext(pi);
	const ctx = makeCtx(project);
	const outcome = await runExpectingFailure(tools.get("dynamic_workflow"), ctx, {
		action: "run",
		name: "selfie",
		timeoutMs: 30_000,
	});
	check("self-recursion: run fails (does not loop)", outcome.threw === true, JSON.stringify(outcome).slice(0, 200));
	check(
		"self-recursion: distinct parent-recursion message",
		/refused recursive call|may not call their parent/i.test(String(outcome.error || "")),
		String(outcome.error || ""),
	);
	check(
		"self-recursion: NOT mislabeled as the nested depth-1 message",
		!/cannot call other sub-workflows/i.test(String(outcome.error || "")),
		String(outcome.error || ""),
	);
}

// --- Scenario 2: a sub-workflow that THROWS propagates to the parent and the run
//     records a workflow phase:"error" event (ok:false, with the message), while a
//     sibling successful child still records phase:"end"/ok:true. The parent here
//     lets the error bubble, so the run fails. ----------------------------------
async function scenarioChildFailurePropagates(url) {
	const project = await makeProject();
	await writeWorkflow(
		project,
		"parent-fatal",
		`
module.exports = async function workflow(ctx) {
  // Positive control: a healthy child first, so we can assert end/ok:true coexists.
  await ctx.workflow("lib/healthy-child", { tag: "ok" });
  // Then a failing child; the parent does NOT catch -> the run must fail.
  await ctx.workflow("lib/throwing-child", {});
  return "unreachable";
};
`,
	);
	await writeWorkflow(
		project,
		"lib/healthy-child",
		`
module.exports = async function workflow(ctx) {
  await ctx.log("healthy child ran");
  return { ok: true };
};
`,
	);
	await writeWorkflow(
		project,
		"lib/throwing-child",
		`
module.exports = async function workflow() {
  throw new Error("child-boom-42");
};
`,
	);

	const ext = await freshExtension(url);
	const { pi, tools } = makePi();
	ext(pi);
	const ctx = makeCtx(project);
	const outcome = await runExpectingFailure(tools.get("dynamic_workflow"), ctx, {
		action: "run",
		name: "parent-fatal",
		timeoutMs: 30_000,
	});
	check(
		"child-failure: uncaught child error fails the run",
		outcome.threw === true,
		JSON.stringify(outcome).slice(0, 200),
	);
	check(
		"child-failure: error surfaces the child's message",
		/child-boom-42/.test(String(outcome.error || "")),
		String(outcome.error || ""),
	);
	check(
		"child-failure: failure surface does not claim the parent return value",
		!/unreachable/.test(outcome.message),
		outcome.message.slice(0, 200),
	);
	check(
		"child-failure: run dir was recoverable from the failure surface",
		Boolean(outcome.runDir),
		outcome.message.slice(0, 200),
	);

	const events = await readEvents(outcome.runDir);
	const errEvent = events.find((e) => e.type === "workflow" && e.phase === "error" && e.name === "lib/throwing-child");
	check(
		"child-failure: records a workflow phase:error event for the failing child",
		Boolean(errEvent),
		JSON.stringify(events.filter((e) => e.type === "workflow")),
	);
	check("child-failure: error event is ok:false", errEvent ? errEvent.ok === false : false, JSON.stringify(errEvent));
	check(
		"child-failure: error event carries the message",
		errEvent ? /child-boom-42/.test(String(errEvent.error || "")) : false,
		JSON.stringify(errEvent),
	);
	// Positive control: the healthy child still emits a clean end/ok:true event.
	const okEvent = events.find(
		(e) => e.type === "workflow" && e.phase === "end" && e.name === "lib/healthy-child" && e.ok === true,
	);
	check(
		"child-failure: healthy sibling still records phase:end/ok:true",
		Boolean(okEvent),
		JSON.stringify(events.filter((e) => e.type === "workflow")),
	);
	// The failing child must NOT also have an end/ok:true event (would mean it was treated as success).
	const falseSuccess = events.find(
		(e) => e.type === "workflow" && e.phase === "end" && e.name === "lib/throwing-child" && e.ok === true,
	);
	check("child-failure: failing child has NO phase:end/ok:true event", !falseSuccess, JSON.stringify(falseSuccess));
}

// --- Scenario 3: the child failure is a NORMAL JS throw the parent can try/catch,
//     so composition failures are RECOVERABLE; the run then succeeds, yet the
//     phase:"error" event is STILL recorded for observability. -------------------
async function scenarioParentRecoversFromChildFailure(url) {
	const project = await makeProject();
	await writeWorkflow(
		project,
		"parent-recover",
		`
module.exports = async function workflow(ctx) {
  let caught = null;
  try {
    await ctx.workflow("lib/throwing-child2", {});
  } catch (err) {
    caught = err instanceof Error ? err.message : String(err);
  }
  // Recovered: continue and produce a real result.
  await ctx.writeArtifact("recovered.json", { caught });
  return { recovered: true, caughtMessage: caught };
};
`,
	);
	await writeWorkflow(
		project,
		"lib/throwing-child2",
		`
module.exports = async function workflow() {
  throw new Error("recoverable-boom-7");
};
`,
	);

	const ext = await freshExtension(url);
	const { pi, tools } = makePi();
	ext(pi);
	const ctx = makeCtx(project);
	const response = await runTool(tools.get("dynamic_workflow"), ctx, {
		action: "run",
		name: "parent-recover",
		timeoutMs: 30_000,
	});
	const result = response.details.result;
	check(
		"recover: run succeeds after parent catches child failure",
		result.ok === true,
		JSON.stringify(result).slice(0, 200),
	);
	check(
		"recover: parent observed the child's error as a throw",
		result.output && result.output.recovered === true,
		JSON.stringify(result.output),
	);
	check(
		"recover: caught message is the child's message",
		/recoverable-boom-7/.test(String(result.output?.caughtMessage)),
		JSON.stringify(result.output),
	);

	const events = await readEvents(result.runDir);
	const errEvent = events.find(
		(e) => e.type === "workflow" && e.phase === "error" && e.name === "lib/throwing-child2",
	);
	check(
		"recover: error event still recorded even though parent recovered",
		Boolean(errEvent) && errEvent.ok === false,
		JSON.stringify(events.filter((e) => e.type === "workflow")),
	);
}

async function main() {
	try {
		const { url } = await buildExtension();
		await scenarioDirectSelfRecursion(url);
		await scenarioChildFailurePropagates(url);
		await scenarioParentRecoversFromChildFailure(url);
		console.log(`\n${passed} passed, ${failed} failed`);
		if (failed) {
			console.log(failures.map((f) => `- ${f}`).join("\n"));
			process.exit(1);
		}
	} catch (err) {
		console.error(err instanceof Error ? err.stack || err.message : err);
		process.exit(2);
	}
}

await main();
