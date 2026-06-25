/**
 * Durable behavioral e2e for the SAFETY GATES of the Pi extensions in this package.
 *
 * Why this file exists
 * --------------------
 * `npm test` is a TYPECHECK only (`tsc --noEmit` over the four extensions). It proves
 * the code compiles; it proves NOTHING about runtime behavior. The most safety-critical
 * parts of these extensions are pure predicate gates that decide whether a tool call is
 * BLOCKED or ALLOWED:
 *   - plan.ts  : the read-only GATE (blockedReason) — what plan mode refuses to run.
 *   - loop.ts  : the autopilot DESTRUCTIVE gate (destructiveReason / isDestructiveBash /
 *                isUnsafeWritePath) — what an unattended autonomous loop refuses to run,
 *                plus the loop_schedule delay CLAMP that bounds the wake cadence.
 * A silent regression in any of these is a real safety hole (e.g. an autonomous loop
 * running `rm -rf`, or plan mode letting an edit through), and `tsc` cannot catch it.
 *
 * Prior sessions wrote equivalent e2e harnesses but left them in a disposable scratchpad,
 * so they vanished between sessions and gave zero durable regression protection. This
 * file is the committed, self-contained version.
 *
 * How it works
 * ------------
 * Self-bootstrapping: it esbuilds the CURRENT extensions/*.ts into an OS temp dir at run
 * time (never a stale bundled copy), then imports the built ESM and drives the REAL
 * registered tools / tool_call handlers against a mocked pi/ctx. It asserts the OBSERVABLE
 * contract (block vs allow, clamped delay), not a copy of the regexes — so it tracks the
 * source and fails loudly if the gate behavior drifts.
 *
 * Run it:
 *   node examples/e2e/safety-gates.e2e.mjs
 * Requirements: esbuild resolvable via `npx esbuild` (already a transitive dev tool here).
 * The extensions' peer deps (typebox, @earendil-works/pi-coding-agent) need NOT be
 * installed: the build aliases those two packages to tiny local stubs (their only use in
 * the exercised gate paths is declaring tool parameter schemas, never validation), so the
 * suite runs from a clean checkout with no `npm install`.
 *
 * Exit code 0 = all checks passed; 1 = a behavioral check failed; 2 = harness crashed.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// examples/e2e/ -> repo root is two levels up.
const REPO_ROOT = path.resolve(__dirname, "..", "..");

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
	const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-safety-e2e-"));

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
		const src = path.join(REPO_ROOT, "extensions", `${name}.ts`);
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

function makeCtx({ mode = "tui", hasUI = true, confirmResult = true, cwd = REPO_ROOT, entries = [] } = {}) {
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
	for (const cmd of ["rm -rf x", "git commit -m wip", "echo x > f", "sed -i 's/a/b/' f", "npm install lodash"]) {
		const r = await runGate(handlers, ctx, toolCallEvent("bash", { command: cmd }));
		check(`plan: BLOCKS bash "${cmd}"`, !!r && r.block === true);
	}

	// ALLOWED: read-only bash + read tools + submit_plan.
	for (const cmd of ["git ls-files", "cat package.json", "grep -n foo bar.ts", "git status"]) {
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
// SCENARIO 3: loop.ts autopilot destructive gate. Only armed while a loop is in
// autopilot (i.e. the turn was triggered by a wake, not a human). Starting a loop
// in tui mode fires the first wake synchronously, setting autopilot=true.
// ===========================================================================
async function loopAutopilotGate(loopUrl) {
	const loopExtension = await freshDefault(loopUrl);
	const { pi, commands, handlers } = makePi();
	loopExtension(pi);
	const cwd = REPO_ROOT;
	const ctx = makeCtx({ mode: "tui", hasUI: true, confirmResult: false, cwd });

	// Before any loop: gate is inert (no autopilot active) -> destructive command allowed.
	const preRm = await runGate(handlers, ctx, toolCallEvent("bash", { command: "rm -rf /tmp/x" }));
	check("loop: rm -rf ALLOWED before any loop (no autopilot)", preRm === undefined);

	// Start a loop. fireWake() runs synchronously and sets autopilot=true on this loop.
	commands.get("loop").handler("keep the build green", ctx);

	// While autopilot is active (confirmResult=false => deny), destructive bash is BLOCKED.
	for (const cmd of [
		"rm -rf build",
		"rm -fr build",
		"git push --force origin main",
		"git push -f",
		"git reset --hard HEAD~1",
		"git clean -fd",
		"dd if=/dev/zero of=/dev/sda",
		"mkfs.ext4 /dev/sdb",
		"terraform apply -auto-approve",
		"kubectl delete pod x",
	]) {
		const r = await runGate(handlers, ctx, toolCallEvent("bash", { command: cmd }));
		check(`loop(autopilot): BLOCKS bash "${cmd}"`, !!r && r.block === true, r ? "" : "not blocked");
	}

	// Non-destructive bash is allowed even under autopilot.
	for (const cmd of ["npm test", "git status", "ls -la", "rm foo.txt", "git commit -m x"]) {
		const r = await runGate(handlers, ctx, toolCallEvent("bash", { command: cmd }));
		check(`loop(autopilot): ALLOWS bash "${cmd}"`, r === undefined, r ? r.reason : "");
	}

	// write/edit: blocked only when the path escapes the project root.
	const outside = await runGate(handlers, ctx, toolCallEvent("write", { file_path: "/etc/passwd", content: "x" }));
	check("loop(autopilot): BLOCKS write to /etc/passwd (outside project)", !!outside && outside.block === true);
	const traversal = await runGate(handlers, ctx, toolCallEvent("edit", { file_path: "../../secret" }));
	check("loop(autopilot): BLOCKS edit via .. traversal", !!traversal && traversal.block === true);
	const inside = await runGate(handlers, ctx, toolCallEvent("write", { file_path: path.join(cwd, "examples/x.txt"), content: "x" }));
	check("loop(autopilot): ALLOWS write inside project", inside === undefined, inside ? inside.reason : "");
	const relInside = await runGate(handlers, ctx, toolCallEvent("write", { file_path: "examples/x.txt", content: "x" }));
	check("loop(autopilot): ALLOWS relative write inside project", relInside === undefined, relInside ? relInside.reason : "");
}

// ===========================================================================
// SCENARIO 4: loop_schedule delay CLAMP to [60, 3600] (the single defense — the
// model is never trusted). Drive the registered tool's execute() directly.
// ===========================================================================
async function loopScheduleClamp(loopUrl) {
	const loopExtension = await freshDefault(loopUrl);
	const { pi, commands, tools } = makePi();
	loopExtension(pi);
	const ctx = makeCtx({ mode: "tui", hasUI: true, cwd: REPO_ROOT });

	// Need a running DYNAMIC loop for loop_schedule to act on.
	commands.get("loop").handler("a dynamic task", ctx);
	const sched = tools.get("loop_schedule");
	check("loop_schedule tool registered", !!sched);

	async function delayFor(raw) {
		const res = await sched.execute("tc", { delaySeconds: raw, reason: "test clamp" }, undefined, undefined, ctx);
		return res.details ? res.details.delaySeconds : undefined;
	}

	check("loop_schedule: 5 clamps up to 60", (await delayFor(5)) === 60);
	check("loop_schedule: 30 clamps up to 60", (await delayFor(30)) === 60);
	check("loop_schedule: 1800 passes through", (await delayFor(1800)) === 1800);
	check("loop_schedule: 99999 clamps down to 3600", (await delayFor(99999)) === 3600);
	check("loop_schedule: 60 (lower bound) stays 60", (await delayFor(60)) === 60);
	check("loop_schedule: 3600 (upper bound) stays 3600", (await delayFor(3600)) === 3600);
	check("loop_schedule: NaN falls back to safety net (1500)", (await delayFor(Number.NaN)) === 1500);
}

// ===========================================================================
async function main() {
	const { outDir, urls } = await buildExtensions(["loop", "plan"]);
	try {
		await planGate(urls.plan);
		await planGatePrintRefuses(urls.plan);
		await loopAutopilotGate(urls.loop);
		await loopScheduleClamp(urls.loop);
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
	// Started loops leave live setTimeout timers (the safety-net re-arm) that keep the
	// event loop open, so exit explicitly rather than hang after a green run.
	process.exit(0);
}

main().catch((err) => {
	console.error("E2E CRASH:", err && err.stack ? err.stack : err);
	process.exit(2);
});
