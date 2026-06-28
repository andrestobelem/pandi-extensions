/**
 * Integration tests for the read-only safety gate in extensions/pi-plan/index.ts.
 *
 * These are not full Pi process integration test tests: they bundle the current extension into
 * a temp dir, load it with a mocked ExtensionAPI/ctx, and assert observable gate
 * behavior.
 *
 * Run it:
 *   node extensions/pi-plan/tests/integration/plan-gate.test.mjs
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { bundle, createChecker, loadDefault, makeBuildDir, sdkStub } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// extensions/<extension>/tests/integration/ -> repo root is four levels up.
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
// Default mocked project cwd. main() points this at the temp build dir so loop
// sidecar writes never pollute the real repo's .pi/loops during tests.
let TEST_PROJECT_ROOT = REPO_ROOT;

// ---------------------------------------------------------------------------
// Assertion harness
// ---------------------------------------------------------------------------
const { check, counts } = createChecker();

// ---------------------------------------------------------------------------
// Build the current extensions to ESM in a temp dir, return import URLs.
// ---------------------------------------------------------------------------
async function buildExtensions(names) {
	// The exercised gate paths only need typebox for tool-schema declaration and the SDK
	// symbols for state-dir resolution — never validation. One shared outDir/stubs keeps
	// getAgentDir consistent across the bundled extensions.
	const { outDir, aliases } = await makeBuildDir("pi-safety-integration", {
		typebox: true,
		sdk: (dir) => sdkStub(dir),
	});
	const urls = {};
	for (const name of names) {
		const packageDir = name.startsWith("pi-") ? name : `pi-${name}`;
		urls[name] = await bundle({
			src: path.join(REPO_ROOT, "extensions", packageDir, "index.ts"),
			outDir,
			outName: `${name}.mjs`,
			aliases,
			npx: "--yes",
		});
	}
	return { outDir, urls };
}

// A module keeps a singleton (activeLoops / activePlans). Load a FRESH instance per
// scenario via a cache-busting query so scenarios never leak state into each other.

// ---------------------------------------------------------------------------
// Mock pi + ctx (shape mirrors the ExtensionAPI / ExtensionContext surface the
// extensions actually use, learned from the real handlers).
// ---------------------------------------------------------------------------
function makePi() {
	const tools = new Map();
	const commands = new Map();
	const handlers = new Map();
	const entries = [];
	const sentMessages = [];
	const pi = {
		registerTool: (def) => tools.set(def.name, def),
		registerCommand: (name, opts) => commands.set(name, opts),
		on: (event, handler) => {
			if (!handlers.has(event)) handlers.set(event, []);
			handlers.get(event).push(handler);
		},
		appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
		sendUserMessage: (content, options) => sentMessages.push({ content, options }),
		exec: async () => ({ code: 0, stdout: "", stderr: "", killed: false }),
	};
	return { pi, tools, commands, handlers, entries, sentMessages };
}

function makeCtx({ mode = "tui", hasUI = true, confirmResult = true, cwd = TEST_PROJECT_ROOT, entries = [] } = {}) {
	const ctx = {
		mode,
		hasUI,
		cwd,
		isIdle: () => true,
		isProjectTrusted: () => true,
		getContextUsage: () => undefined,
		ui: {
			theme: { fg: (_c, s) => s },
			notify: () => {},
			setStatus: () => {},
			confirm: async () => ctx._confirmResult,
			select: async () => undefined,
		},
		sessionManager: { getEntries: () => entries },
	};
	ctx._confirmResult = confirmResult;
	return ctx;
}

function toolCallEvent(toolName, input = {}) {
	return {
		type: "tool_call",
		toolCallId: "tc-" + Math.random().toString(16).slice(2),
		toolName,
		input,
	};
}

// Run every registered tool_call handler; first blocker wins (mirrors the engine).
async function runGate(handlers, ctx, event) {
	for (const h of handlers.get("tool_call") || []) {
		const res = await h(event, ctx);
		if (res && res.block) return res;
	}
	return undefined;
}

// ===========================================================================
// SCENARIO 1: plan.ts read-only gate (only armed while a plan is active).
// ===========================================================================
async function planGate(planUrl) {
	const planExtension = await loadDefault(planUrl);
	const { pi, commands, handlers } = makePi();
	planExtension(pi);
	const ctx = makeCtx({ mode: "tui", hasUI: true });

	// Before entering plan mode, nothing is gated.
	const preWrite = await runGate(handlers, ctx, toolCallEvent("write", { file_path: "a.ts", content: "x" }));
	check("plan: write ALLOWED before /plan (gate not armed)", preWrite === undefined);

	// Enter plan mode.
	await commands.get("plan").handler("design a feature", ctx);

	// BLOCKED: structured mutators.
	for (const [name, input] of [
		["write", { file_path: "a.ts", content: "x" }],
		["edit", { file_path: "a.ts" }],
		["notebook-edit", { path: "n.ipynb" }],
	]) {
		const r = await runGate(handlers, ctx, toolCallEvent(name, input));
		check(`plan: BLOCKS ${name}`, !!r && r.block === true && /read-only/i.test(r.reason || ""));
	}

	// BLOCKED: mutating bash.
	for (const cmd of [
		"rm -rf x",
		"mkdir generated",
		"touch generated.txt",
		"chmod +x script.sh",
		"git commit -m wip",
		"echo x > f",
		"node test.js 2>err.log",
		"sed -i 's/a/b/' f",
		"npm install lodash",
		"cp template.txt config.json",
		"ln -sf /etc/hosts ./link",
		"install -m 0755 a b",
	]) {
		const r = await runGate(handlers, ctx, toolCallEvent("bash", { command: cmd }));
		check(`plan: BLOCKS bash "${cmd}"`, !!r && r.block === true);
	}

	// CHARACTERIZATION (documented known false positive — L2-low). A read-only grep whose
	// pattern contains a spaced '>' inside quotes is CURRENTLY blocked by the redirect
	// heuristic /(^|[^&>=-])>>?\s*(?![&>=])/. A quoted spaced '>' is lexically identical to a
	// real redirect (echo x > f); only quoting distinguishes them. The gate errs SAFE (no real
	// mutation) at the cost of plan-mode UX. Pinned so any future regex refinement that ALLOWS
	// this is an INTENTIONAL, reviewed change (and must keep real redirects blocked).
	{
		const cmd = 'grep -rn "len(x) > 0" .';
		const r = await runGate(handlers, ctx, toolCallEvent("bash", { command: cmd }));
		check(`plan: documents redirect false positive — BLOCKS bash "${cmd}"`, !!r && r.block === true);
	}

	// ALLOWED: read-only bash + read tools + submit_plan. The last four are read-only commands
	// whose operators (->, >=, =>) must NOT be mistaken for write redirections (F12).
	for (const cmd of [
		"git ls-files",
		"cat package.json",
		"grep -n foo bar.ts",
		"git status",
		'grep -rn "foo->bar" src',
		"awk '$3 >= 100' f",
		'git log --grep "x -> y"',
		'echo "x => y"',
	]) {
		const r = await runGate(handlers, ctx, toolCallEvent("bash", { command: cmd }));
		check(`plan: ALLOWS bash "${cmd}"`, r === undefined, r ? r.reason : "");
	}
	for (const name of ["read", "grep", "find", "ls", "submit_plan"]) {
		const r = await runGate(handlers, ctx, toolCallEvent(name, {}));
		check(`plan: ALLOWS ${name}`, r === undefined, r ? r.reason : "");
	}

	// dynamic_workflow: mutating actions blocked, read-only actions allowed, missing action blocked.
	for (const action of ["write", "run", "start", "resume", undefined]) {
		const r = await runGate(handlers, ctx, toolCallEvent("dynamic_workflow", action ? { action } : {}));
		check(`plan: BLOCKS dynamic_workflow action=${String(action)}`, !!r && r.block === true);
	}
	for (const action of ["list", "template", "read", "graph", "runs", "view"]) {
		const r = await runGate(handlers, ctx, toolCallEvent("dynamic_workflow", { action }));
		check(`plan: ALLOWS dynamic_workflow action=${action}`, r === undefined, r ? r.reason : "");
	}
}

// ===========================================================================
// SCENARIO 2: plan.ts gate is NOT armed in print mode (cannot run the approval
// handshake there, so /plan refuses to enter and never gates).
// ===========================================================================
async function planGatePrintRefuses(planUrl) {
	const planExtension = await loadDefault(planUrl);
	const { pi, commands, handlers, entries, sentMessages } = makePi();
	planExtension(pi);
	const ctx = makeCtx({ mode: "print", hasUI: false });

	const logged = [];
	const origLog = console.log;
	console.log = (...a) => logged.push(a.join(" "));
	try {
		await commands.get("plan").handler("do a thing", ctx);
	} finally {
		console.log = origLog;
	}
	check("plan(print): no plan-state persisted", entries.find((e) => e.customType === "plan-state") === undefined);
	check("plan(print): no planning prompt injected", sentMessages.length === 0);
	const r = await runGate(handlers, ctx, toolCallEvent("write", { file_path: "a.ts", content: "x" }));
	check("plan(print): write ALLOWED (gate never armed)", r === undefined);
	check(
		"plan(print): refusal mentions TUI or RPC",
		logged.some((l) => /TUI or RPC/i.test(l)),
	);
}

// ===========================================================================
// SCENARIO 3: NON-INTERACTIVE plan-only entry (json + PI_PLAN_NONINTERACTIVE=1) ARMS the
// gate and KEEPS it armed across a plan-only submit_plan (the gate never lifts without a
// human). This is the path a dynamic-workflow subagent uses.
// ===========================================================================
async function planGateNonInteractiveArms(planUrl) {
	const planExtension = await loadDefault(planUrl);
	const { pi, tools, handlers } = makePi();
	planExtension(pi);
	const ctx = makeCtx({ mode: "json", hasUI: false });
	process.env.PI_PLAN_NONINTERACTIVE = "1";
	try {
		const pre = await runGate(handlers, ctx, toolCallEvent("write", { file_path: "a.ts", content: "x" }));
		check("plan(non-interactive): write ALLOWED before entry", pre === undefined);
		const res = await tools
			.get("enter_plan_mode")
			.execute("tc1", { task: "plan inside a subagent" }, undefined, undefined, ctx);
		check("plan(non-interactive): entered=true in json mode", !!res && res.details && res.details.entered === true);
		const post = await runGate(handlers, ctx, toolCallEvent("write", { file_path: "a.ts", content: "x" }));
		check("plan(non-interactive): write BLOCKED after entry (gate armed)", !!post && post.block === true);
		// A plan-only submit_plan must NOT lift the gate (no human approval here).
		await tools.get("submit_plan").execute("tc2", { plan: "# Plan\n1. step" }, undefined, undefined, ctx);
		const after = await runGate(handlers, ctx, toolCallEvent("edit", { file_path: "a.ts" }));
		check("plan(non-interactive): edit STILL BLOCKED after plan-only submit", !!after && after.block === true);
	} finally {
		delete process.env.PI_PLAN_NONINTERACTIVE;
	}
}

// ===========================================================================
async function main() {
	const { outDir, urls } = await buildExtensions(["plan"]);
	TEST_PROJECT_ROOT = path.join(outDir, "project");
	await fs.mkdir(TEST_PROJECT_ROOT, { recursive: true });
	try {
		await planGate(urls.plan);
		await planGatePrintRefuses(urls.plan);
		await planGateNonInteractiveArms(urls.plan);
	} finally {
		await fs.rm(outDir, { recursive: true, force: true }).catch(() => {});
	}

	console.log("");
	console.log(`TOTAL: ${counts.passed} passed, ${counts.failed} failed`);
	if (counts.failed > 0) {
		console.log("FAILURES:");
		for (const f of counts.failures) console.log(`  - ${f}`);
		process.exit(1);
	}
	// Started loops leave live setTimeout timers in loop tests; exit explicitly so
	// the behavior runner never hangs after a green run.
	process.exit(0);
}

main().catch((err) => {
	console.error("INTEGRATION TEST CRASH:", err && err.stack ? err.stack : err);
	process.exit(2);
});
