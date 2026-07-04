/**
 * Durable CHARACTERIZATION suite for the still-uncovered seams of extensions/pandi-plan/index.ts.
 *
 * The existing plan-approval / plan-gate suites already pin the read-only gate, the
 * approve/reject/exit handshake, autonomous entry, plan-only mode, ultracode knobs, the
 * dashboard and the session toggles. This file fills the residual coverage gaps found by a
 * coverage audit, asserting the source's CURRENT behavior (the source is the source of truth):
 *
 *   1. submit_plan DEGRADED no-UI fallback — a plan armed in an interactive ctx, then
 *      submitted through a ctx where ctx.ui.confirm is missing (and NOT plan-only): the tool
 *      WARNS, reports details.reason="no-ui"/status="planning", does NOT auto-approve, leaves
 *      the gate armed, and injects NO implement message.
 *   2. /plan while a plan is already active — warns (/already active/), returns the SAME plan,
 *      and never arms a second plan (one planId only).
 *   3. session_shutdown — persists the active plan VERBATIM (active=true, status=planning) so
 *      a later session_start(resume) over those entries re-arms the gate.
 *   4. isPlanModeActive() + the PLAN_MODE_GUARD global guard registration and previous-guard
 *      chaining (a prior guard that returns true still reports active; one that throws is
 *      swallowed → false).
 *   5. wake delivery — busy (isIdle=false) approval delivers via options.deliverAs="followUp";
 *      idle approval steers with no deliverAs; the no-UI degraded path never wakes.
 *
 * Self-bootstrapping like its sibling suites: esbuild the CURRENT index.ts into a temp dir
 * (typebox + SDK stubbed), import the built ESM, drive the REAL command/tool/handlers against
 * a mocked pi/ctx, and assert the OBSERVABLE contract only.
 *
 * Run it:    node extensions/pandi-plan/tests/integration/index-coverage.test.mjs
 * Exit code: 0 = all checks passed; 1 = a behavioral check failed; 2 = harness crashed.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExtension, createChecker, loadDefault, loadModule, sdkStub } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// extensions/pandi-plan/tests/integration/ -> repo root is four levels up.
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

const { check, counts } = createChecker();

async function buildPlan() {
	return await buildExtension({
		name: "pi-plan-index-coverage-integration",
		src: path.join(REPO_ROOT, "extensions", "pandi-plan", "index.ts"),
		outName: "plan.mjs",
		stubs: { typebox: true, sdk: (dir) => sdkStub(dir) },
	});
}

// ---------------------------------------------------------------------------
// Mock pi + ctx (same surface the sibling suites encode).
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

// `confirm` can be omitted entirely (set ui.confirm:"omit") to exercise the degraded path.
function makeCtx({ mode = "tui", hasUI = true, confirmResult = true, idle = true, entries = [], confirm } = {}) {
	const notes = [];
	const ui = {
		theme: { fg: (_c, s) => s },
		notify: (msg, type) => notes.push({ msg, type }),
		setStatus: () => {},
		select: async () => undefined,
	};
	if (confirm !== "omit") {
		ui.confirm = async () => {
			const r = ctx._confirmResult;
			if (Array.isArray(r)) return r.shift();
			if (typeof r === "function") return r();
			return r;
		};
	}
	const ctx = {
		mode,
		hasUI,
		cwd: REPO_ROOT,
		isIdle: () => idle,
		isProjectTrusted: () => true,
		getContextUsage: () => undefined,
		ui,
		sessionManager: { getEntries: () => entries },
	};
	ctx._confirmResult = confirmResult;
	ctx._notes = notes;
	return ctx;
}

function toolCallEvent(toolName, input = {}) {
	return { type: "tool_call", toolCallId: `tc-${Math.random().toString(16).slice(2)}`, toolName, input };
}

async function runGate(handlers, ctx, event) {
	for (const h of handlers.get("tool_call") || []) {
		const res = await h(event, ctx);
		if (res?.block) return res;
	}
	return undefined;
}

async function writeBlocked(handlers, ctx) {
	const r = await runGate(handlers, ctx, toolCallEvent("write", { file_path: "a.ts", content: "x" }));
	return !!r && r.block === true;
}

function latestPlanState(entries) {
	let latest;
	for (const e of entries) if (e.customType === "plan-state") latest = e.data;
	return latest;
}

function planStateIds(entries) {
	const ids = new Set();
	for (const e of entries) if (e.customType === "plan-state" && e.data?.planId) ids.add(e.data.planId);
	return ids;
}

async function fireSessionStart(handlers, ctx, reason = "resume") {
	for (const h of handlers.get("session_start") || []) await h({ reason }, ctx);
}

async function fireSessionShutdown(handlers, ctx) {
	for (const h of handlers.get("session_shutdown") || []) await h({}, ctx);
}

// ===========================================================================
// GAP 1: submit_plan DEGRADED no-UI fallback (interactive-ish path, confirm missing).
// ===========================================================================
async function submitNoUiDegrades(url) {
	const planExtension = await loadDefault(url);
	const { pi, commands, tools, handlers, entries, sentMessages } = makePi();
	planExtension(pi);

	// Arm via /plan in a normal interactive ctx (confirm available) → not plan-only.
	const armCtx = makeCtx({ mode: "tui", hasUI: true });
	await commands.get("plan").handler("design a feature", armCtx);
	const afterEntry = sentMessages.length; // planning prompt injected on entry
	check("no-ui: write BLOCKED while planning", await writeBlocked(handlers, armCtx));

	// Submit through a degraded ctx: hasUI=true but ctx.ui.confirm is missing.
	const degraded = makeCtx({ mode: "tui", hasUI: true, confirm: "omit" });
	check("no-ui: degraded ctx really has no confirm", typeof degraded.ui.confirm !== "function");
	const res = await tools
		.get("submit_plan")
		.execute("tc1", { plan: "# Plan\n1. step" }, undefined, undefined, degraded);

	check("no-ui: tool result details.reason='no-ui'", res?.details && res.details.reason === "no-ui");
	check("no-ui: tool result details.status='planning'", res?.details && res.details.status === "planning");
	check("no-ui: tool result approved=false", res?.details && res.details.approved === false);
	check("no-ui: tool result is NOT an error (degraded, not crash)", !res?.details?.isError);
	check(
		"no-ui: warned via notify",
		degraded._notes.some((n) => n.type === "warning" && /approval dialog/i.test(n.msg)),
	);

	// Did NOT auto-approve: the gate stays armed and no implement message was injected.
	check("no-ui: write STILL BLOCKED after submit (gate not lifted)", await writeBlocked(handlers, degraded));
	check("no-ui: NO implement message injected", sentMessages.length === afterEntry);
	check("no-ui: no message says 'Implement now'", !sentMessages.some((m) => /Implement now/i.test(m.content)));

	// Persisted state remains active/planning (submission counted on entry to the tool).
	const st = latestPlanState(entries);
	check("no-ui: persisted active=true (still planning)", st && st.active === true);
	check("no-ui: persisted status=planning", st && st.status === "planning");
	check("no-ui: submission counted (1)", st && st.submissions === 1);
}

// ===========================================================================
// GAP 2: /plan while a plan is already active → warning, same plan, no 2nd plan.
// ===========================================================================
async function planAlreadyActiveWarns(url) {
	const planExtension = await loadDefault(url);
	const { pi, commands, handlers, entries } = makePi();
	planExtension(pi);
	const ctx = makeCtx({ mode: "tui", hasUI: true });

	await commands.get("plan").handler("task1", ctx);
	const firstState = latestPlanState(entries);
	check("already-active: first /plan armed the gate", await writeBlocked(handlers, ctx));
	const notesBefore = ctx._notes.length;

	await commands.get("plan").handler("task2", ctx);
	check(
		"already-active: warns with /already active/",
		ctx._notes.slice(notesBefore).some((n) => n.type === "warning" && /already active/i.test(n.msg)),
	);

	const ids = planStateIds(entries);
	check("already-active: only ONE plan planId ever persisted", ids.size === 1);
	const lastState = latestPlanState(entries);
	check(
		"already-active: latest state is still the FIRST plan (no second armed)",
		lastState && firstState && lastState.planId === firstState.planId && lastState.task === "task1",
	);
}

// ===========================================================================
// GAP 3: session_shutdown persists the active plan verbatim → reload re-arms.
// ===========================================================================
async function shutdownPersistsActivePlan(url) {
	const planExtension = await loadDefault(url);
	const { pi, commands, handlers, entries } = makePi();
	planExtension(pi);
	const ctx = makeCtx({ mode: "tui", hasUI: true });

	await commands.get("plan").handler("ship it", ctx);
	check("shutdown: gate armed before shutdown", await writeBlocked(handlers, ctx));

	await fireSessionShutdown(handlers, ctx);
	const st = latestPlanState(entries);
	check("shutdown: persisted active=true (verbatim)", st && st.active === true);
	check("shutdown: persisted status=planning (unchanged)", st && st.status === "planning");

	// A subsequent reload over those entries re-arms the gate. session_start clears the
	// in-memory map then rehydrates from ctx.sessionManager.getEntries().
	const reloadCtx = makeCtx({ mode: "tui", hasUI: true, entries: [...entries] });
	await fireSessionStart(handlers, reloadCtx, "resume");
	check("shutdown→reload: gate RE-ARMED from persisted active plan", await writeBlocked(handlers, reloadCtx));
}

// ===========================================================================
// GAP 4: isPlanModeActive() + PLAN_MODE_GUARD registration & previous-guard chaining.
// ===========================================================================
async function planModeGuardChaining(url) {
	const GUARD_SYMBOL = Symbol.for("pi-dynamic-workflows.plan-mode.guard");

	// --- 4a: isPlanModeActive() is false on a fresh import, true after entering a plan. ---
	{
		const mod = await loadModule(url);
		check("guard: isPlanModeActive() is a function", typeof mod.isPlanModeActive === "function");
		check("guard: isPlanModeActive() false on a fresh import", mod.isPlanModeActive() === false);
		const { pi, commands } = makePi();
		mod.default(pi);
		const ctx = makeCtx({ mode: "tui", hasUI: true });
		await commands.get("plan").handler("a task", ctx);
		check("guard: isPlanModeActive() true after entering a plan", mod.isPlanModeActive() === true);
		// PLAN_MODE_GUARD reflects the same active state and is registered on the global symbol.
		check("guard: PLAN_MODE_GUARD.isActive() true when a plan is active", mod.PLAN_MODE_GUARD.isActive() === true);
		check(
			"guard: module registered PLAN_MODE_GUARD on the global symbol",
			globalThis[GUARD_SYMBOL] === mod.PLAN_MODE_GUARD,
		);
	}

	// --- 4b: a previous guard that returns true makes PLAN_MODE_GUARD report active even
	//         when this module has no active plan (chaining). ---
	{
		globalThis[GUARD_SYMBOL] = { isActive: () => true };
		const mod = await loadModule(url);
		check("guard(chain-true): no local active plan", mod.isPlanModeActive() === false);
		check("guard(chain-true): PLAN_MODE_GUARD chains to previous=true", mod.PLAN_MODE_GUARD.isActive() === true);
	}

	// --- 4c: a previous guard that THROWS is swallowed → false. ---
	{
		globalThis[GUARD_SYMBOL] = {
			isActive: () => {
				throw new Error("boom");
			},
		};
		const mod = await loadModule(url);
		let threw = false;
		let result;
		try {
			result = mod.PLAN_MODE_GUARD.isActive();
		} catch {
			threw = true;
		}
		check("guard(chain-throw): does NOT propagate the previous guard's throw", threw === false);
		check("guard(chain-throw): swallowed throw → isActive() false", result === false);
	}
}

// ===========================================================================
// GAP 5: wake delivery — busy→followUp, idle→steer, no-UI degraded never wakes.
// ===========================================================================
async function wakeDelivery(url) {
	// --- 5a: BUSY (isIdle=false) approval delivers the implement message as followUp. ---
	{
		const planExtension = await loadDefault(url);
		const { pi, commands, tools, sentMessages } = makePi();
		planExtension(pi);
		const ctx = makeCtx({ mode: "tui", hasUI: true, confirmResult: true, idle: false });
		await commands.get("plan").handler("ship it", ctx);
		const res = await tools.get("submit_plan").execute("tc1", { plan: "# Plan\n1. step" }, undefined, undefined, ctx);
		check("wake(busy): submit approved", res?.details && res.details.status === "approved");
		const wake = sentMessages[sentMessages.length - 1];
		check("wake(busy): implement message injected", wake && /Implement now/i.test(wake.content));
		check("wake(busy): delivered as followUp", wake?.options && wake.options.deliverAs === "followUp");
	}

	// --- 5b: IDLE approval steers with sendUserMessage and NO deliverAs option. ---
	{
		const planExtension = await loadDefault(url);
		const { pi, commands, tools, sentMessages } = makePi();
		planExtension(pi);
		const ctx = makeCtx({ mode: "tui", hasUI: true, confirmResult: true, idle: true });
		await commands.get("plan").handler("ship it", ctx);
		await tools.get("submit_plan").execute("tc1", { plan: "# Plan\n1. step" }, undefined, undefined, ctx);
		const wake = sentMessages[sentMessages.length - 1];
		check("wake(idle): implement message injected", wake && /Implement now/i.test(wake.content));
		check(
			"wake(idle): NO deliverAs option (steered, not followUp)",
			!wake?.options || wake.options.deliverAs === undefined,
		);
	}

	// --- 5c: the degraded no-UI submit path never wakes (no implement message at all). ---
	{
		const planExtension = await loadDefault(url);
		const { pi, commands, tools, sentMessages } = makePi();
		planExtension(pi);
		const armCtx = makeCtx({ mode: "tui", hasUI: true });
		await commands.get("plan").handler("ship it", armCtx);
		const afterEntry = sentMessages.length;
		const degraded = makeCtx({ mode: "tui", hasUI: true, confirm: "omit" });
		await tools.get("submit_plan").execute("tc1", { plan: "# Plan\n1. step" }, undefined, undefined, degraded);
		check("wake(no-ui): no implement message injected on the degraded path", sentMessages.length === afterEntry);
	}
}

// ===========================================================================
async function main() {
	const { outDir, url } = await buildPlan();
	try {
		await submitNoUiDegrades(url);
		await planAlreadyActiveWarns(url);
		await shutdownPersistsActivePlan(url);
		await planModeGuardChaining(url);
		await wakeDelivery(url);
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
	process.exit(0);
}

main().catch((err) => {
	console.error("INTEGRATION TEST CRASH:", err?.stack ? err.stack : err);
	process.exit(2);
});
