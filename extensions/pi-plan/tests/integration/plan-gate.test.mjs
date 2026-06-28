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

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// extensions/<extension>/tests/integration/ -> repo root is four levels up.
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
// Default mocked project cwd. main() points this at the temp build dir so loop
// sidecar writes never pollute the real repo's .pi/loops during tests.
let TEST_PROJECT_ROOT = REPO_ROOT;

// ---------------------------------------------------------------------------
// Assertion harness
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Build the current extensions to ESM in a temp dir, return import URLs.
// ---------------------------------------------------------------------------
async function buildExtensions(names) {
	const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-safety-integration-"));

	// Tiny stubs for the two external peer packages. The exercised gate paths only need
	// these symbols for tool-schema declaration + state-dir resolution — never validation.
	const typeboxStub = path.join(outDir, "stub-typebox.mjs");
	await fs.writeFile(
		typeboxStub,
		"const id = (x) => x ?? {};\nexport const Type = { Object: id, Number: id, String: id, Boolean: id, Array: id, Optional: id, Union: id, Literal: id, Any: id };\nexport default { Type };\n",
	);
	const sdkStub = path.join(outDir, "stub-sdk.mjs");
	await fs.writeFile(
		sdkStub,
		`export const CONFIG_DIR_NAME = ".pi";\nexport function getAgentDir() { return ${JSON.stringify(path.join(outDir, "agentdir"))}; }\n`,
	);

	const urls = {};
	for (const name of names) {
		const packageDir = name.startsWith("pi-") ? name : `pi-${name}`;
		const src = path.join(REPO_ROOT, "extensions", packageDir, "index.ts");
		if (!existsSync(src)) throw new Error(`missing source: ${src}`);
		const out = path.join(outDir, `${name}.mjs`);
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
				`--alias:@earendil-works/pi-coding-agent=${sdkStub}`,
				`--outfile=${out}`,
			],
			{ cwd: REPO_ROOT, encoding: "utf8" },
		);
		if (r.status !== 0) {
			throw new Error(`esbuild failed for ${name}: ${r.stderr || r.stdout}`);
		}
		urls[name] = pathToFileURL(out).href;
	}
	return { outDir, urls };
}

// A module keeps a singleton (activeLoops / activePlans). Load a FRESH instance per
// scenario via a cache-busting query so scenarios never leak state into each other.
let _instance = 0;
async function freshDefault(url) {
	const mod = await import(`${url}?i=${_instance++}`);
	return mod.default;
}

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
	return { type: "tool_call", toolCallId: "tc-" + Math.random().toString(16).slice(2), toolName, input };
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
	const planExtension = await freshDefault(planUrl);
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
	for (const cmd of ["rm -rf x", "mkdir generated", "touch generated.txt", "chmod +x script.sh", "git commit -m wip", "echo x > f", "node test.js 2>err.log", "sed -i 's/a/b/' f", "npm install lodash"]) {
		const r = await runGate(handlers, ctx, toolCallEvent("bash", { command: cmd }));
		check(`plan: BLOCKS bash "${cmd}"`, !!r && r.block === true);
	}

	// ALLOWED: read-only bash + read tools + submit_plan. The last four are read-only commands
	// whose operators (->, >=, =>) must NOT be mistaken for write redirections (F12).
	for (const cmd of ["git ls-files", "cat package.json", "grep -n foo bar.ts", "git status", 'grep -rn "foo->bar" src', "awk '$3 >= 100' f", 'git log --grep "x -> y"', 'echo "x => y"']) {
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
	const planExtension = await freshDefault(planUrl);
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
	check("plan(print): refusal mentions TUI or RPC", logged.some((l) => /TUI or RPC/i.test(l)));
}

// ===========================================================================
async function main() {
	const { outDir, urls } = await buildExtensions(["plan"]);
	TEST_PROJECT_ROOT = path.join(outDir, "project");
	await fs.mkdir(TEST_PROJECT_ROOT, { recursive: true });
	try {
		await planGate(urls.plan);
		await planGatePrintRefuses(urls.plan);
	} finally {
		await fs.rm(outDir, { recursive: true, force: true }).catch(() => {});
	}

	console.log("");
	console.log(`TOTAL: ${passed} passed, ${failed} failed`);
	if (failed > 0) {
		console.log("FAILURES:");
		for (const f of failures) console.log(`  - ${f}`);
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
