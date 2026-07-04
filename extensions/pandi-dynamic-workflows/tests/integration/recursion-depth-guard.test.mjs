/**
 * Behavior: the PI_DYNAMIC_WORKFLOWS_DEPTH recursion guard.
 *
 * ctx.workflow() composition is depth-1 and a single run is bounded by maxAgents, but a
 * subagent spawned with includeExtensions:true + the dynamic_workflow tool could otherwise
 * launch fresh top-level runs not counted against the parent budget — unbounded nesting.
 * The guard propagates a per-session DEPTH into every spawned subagent (depth+1) and REFUSES
 * start/run/resume once a session is at the limit (default 2, override PI_DYNAMIC_WORKFLOWS_MAX_DEPTH).
 *
 * This pins the REFUSE side (the safety guarantee) + the allowed boundary + the override.
 * Propagation into spawned subagents is a single env pass on the spawn and is not exercised
 * here (it requires a real `pi` subprocess).
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
function check(label, cond, detail) {
	if (cond) {
		passed += 1;
		console.log(`PASS: ${label}`);
	} else {
		failed += 1;
		console.log(`FAIL: ${label}${detail ? `  [${String(detail).slice(0, 200)}]` : ""}`);
	}
}

async function buildExtension() {
	return await sharedBuildExtension({
		name: "pi-dwf-recursion-guard",
		src: path.join(REPO_ROOT, "extensions", "pandi-dynamic-workflows", "index.ts"),
		outName: "dynamic-workflows.mjs",
		copyDirs: { scaffolds: path.join(REPO_ROOT, "extensions", "pandi-dynamic-workflows", "scaffolds") },
		stubs: {
			typebox: true,
			typeboxValue: true,
			ai: true,
			tui: true,
			sdk: (dir) => sdkStub(dir, { customEditor: "render" }),
		},
	});
}

function makePi() {
	const tools = new Map();
	const pi = {
		registerTool: (def) => tools.set(def.name, def),
		registerCommand: () => {},
		registerShortcut: () => {},
		on: () => {},
		appendEntry: () => {},
		sendUserMessage: () => {},
		getThinkingLevel: () => undefined,
		getActiveTools: () => [],
		getAllTools: () => [...tools.values()],
		setActiveTools: () => {},
		exec: async () => ({ code: 0, killed: false, stdout: "", stderr: "" }),
	};
	return { pi, tools };
}

function makeCtx(cwd) {
	return {
		mode: "print",
		hasUI: false,
		cwd,
		isIdle: () => true,
		isProjectTrusted: () => true,
		getContextUsage: () => undefined,
		ui: {
			theme: { fg: (_c, v) => v },
			notify: () => {},
			setStatus: () => {},
			setWidget: () => {},
			confirm: async () => true,
			select: async () => undefined,
			editor: async (_t, i = "") => i,
			custom: async () => undefined,
			getEditorComponent: () => undefined,
			setEditorComponent: () => {},
		},
		sessionManager: { getEntries: () => [] },
	};
}

async function makeProject() {
	const project = await fs.mkdtemp(path.join(os.tmpdir(), "pi-dwf-recursion-project-"));
	await fs.mkdir(path.join(project, ".pi", "workflows"), { recursive: true });
	await fs.writeFile(
		path.join(project, ".pi", "workflows", "noop.js"),
		"module.exports = async function workflow(ctx, input) {\n  return { ok: true };\n};\n",
		"utf8",
	);
	return project;
}

async function runTool(tool, ctx, params) {
	return await tool.execute("tc-depth", params, new AbortController().signal, undefined, ctx);
}

/** Invoke the tool and capture the thrown error message (or undefined if it did not throw). */
async function expectThrow(tool, ctx, params) {
	try {
		await runTool(tool, ctx, params);
		return undefined;
	} catch (err) {
		return err instanceof Error ? err.message : String(err);
	}
}

const { url } = await buildExtension();
const mod = await import(url);
const ext = mod.default;
const project = await makeProject();
const { pi, tools } = makePi();
(ext.activate ?? ext)(pi, makeCtx(project));
const tool = tools.get("dynamic_workflow");
const ctx = makeCtx(project);

// Clean env baseline; restore at the end.
const savedDepth = process.env.PI_DYNAMIC_WORKFLOWS_DEPTH;
const savedMax = process.env.PI_DYNAMIC_WORKFLOWS_MAX_DEPTH;
delete process.env.PI_DYNAMIC_WORKFLOWS_DEPTH;
delete process.env.PI_DYNAMIC_WORKFLOWS_MAX_DEPTH;

try {
	// 1) At the default limit (depth=2) start/run/resume are REFUSED with the guard message.
	process.env.PI_DYNAMIC_WORKFLOWS_DEPTH = "2";
	for (const action of ["start", "run", "resume"]) {
		const msg = await expectThrow(tool, ctx, { action, name: "noop" });
		check(`depth=2: ${action} refused by recursion guard`, !!msg && /recursion guard/i.test(msg), msg);
	}

	// 2) A read-only action (scaffold) is NEVER refused, even at/over the limit.
	{
		const msg = await expectThrow(tool, ctx, { action: "scaffold" });
		check("depth=2: read-only scaffold is NOT refused", msg === undefined, msg);
	}

	// 3) Below the limit (depth=1) a run proceeds past the guard (executes the noop workflow).
	{
		process.env.PI_DYNAMIC_WORKFLOWS_DEPTH = "1";
		const res = await runTool(tool, ctx, { action: "run", name: "noop", timeoutMs: 30_000 });
		check("depth=1: run is allowed (below limit)", res?.details?.result?.ok === true, JSON.stringify(res?.details));
	}

	// 4) Override: PI_DYNAMIC_WORKFLOWS_MAX_DEPTH raises the limit so depth=2 is allowed again.
	{
		process.env.PI_DYNAMIC_WORKFLOWS_DEPTH = "2";
		process.env.PI_DYNAMIC_WORKFLOWS_MAX_DEPTH = "5";
		const res = await runTool(tool, ctx, { action: "run", name: "noop", timeoutMs: 30_000 });
		check(
			"depth=2 + max=5: run allowed via override",
			res?.details?.result?.ok === true,
			JSON.stringify(res?.details),
		);
		delete process.env.PI_DYNAMIC_WORKFLOWS_MAX_DEPTH;
	}

	// 5) Top-level (depth unset = 0) start is not refused by the guard.
	{
		delete process.env.PI_DYNAMIC_WORKFLOWS_DEPTH;
		const msg = await expectThrow(tool, ctx, { action: "run", name: "noop", timeoutMs: 30_000 });
		check("depth=0 (top-level): run is allowed", msg === undefined || !/recursion guard/i.test(msg), msg);
	}
} finally {
	if (savedDepth === undefined) delete process.env.PI_DYNAMIC_WORKFLOWS_DEPTH;
	else process.env.PI_DYNAMIC_WORKFLOWS_DEPTH = savedDepth;
	if (savedMax === undefined) delete process.env.PI_DYNAMIC_WORKFLOWS_MAX_DEPTH;
	else process.env.PI_DYNAMIC_WORKFLOWS_MAX_DEPTH = savedMax;
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
