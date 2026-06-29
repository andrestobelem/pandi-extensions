/**
 * Durable behavioral integration test for the APPROVAL HANDSHAKE + LIFECYCLE of plan.ts.
 *
 * Why this file exists (and why it is NOT a duplicate of safety-gates)
 * -------------------------------------------------------------------
 * `plan-gate.test.mjs / loop-safety.test.mjs` already pins the READ-ONLY GATE of plan.ts: the pure
 * `blockedReason` predicate (which tool calls are blocked vs allowed while the mode is
 * armed) and the print/json refusal-to-enter. That is the "what does the gate refuse"
 * half of plan mode.
 *
 * It does NOT cover the OTHER half — the part the module doc calls "the new parts": the
 * APPROVAL HANDSHAKE and the mode LIFECYCLE. Those are the most consequential behaviors of
 * plan.ts and are entirely runtime/state-machine (invisible to `tsc`):
 *
 *   1. submit_plan + confirm=APPROVE  → LIFTS the gate (a mutation that was blocked is now
 *      ALLOWED), persists status="approved"/active=false, RE-INJECTS the implementation
 *      message ("Plan approved. Implement now:\n\n<plan>"), and reports status="approved".
 *   2. submit_plan + confirm=REJECT   → KEEPS the gate armed (the same mutation stays
 *      BLOCKED), counts the rejection, returns the rejection to the model, and DOES NOT wake.
 *      Then a follow-up APPROVE still works → the revise→resubmit→approve lifecycle.
 *   3. /plan exit|cancel               → ABORTS: lifts the gate, status="exited", and DOES
 *      NOT re-inject an implementation message (no implicit implement).
 *   4. submit_plan with NO active plan → isError, no crash, no state mutation.
 *   5. rehydrate after reload (session_start) → an ACTIVE plan RE-ARMS the gate (a mutation
 *      blocked again); a TERMINAL plan (approved/exited) does NOT; last-wins by planId; a
 *      "fork" is a no-op; rehydrate does NOT re-inject the planning prompt.
 *
 * A silent regression in any of these is a real defect: the dangerous direction is
 * approve-not-lifting (stuck read-only) or — far worse — reject/exit accidentally LIFTING
 * the gate or auto-approving, which would let the model mutate the workspace without the
 * user's explicit approval. That is exactly the guarantee the whole feature exists to make,
 * and `tsc` cannot see it.
 *
 * How it works (same self-bootstrapping pattern as the other integration suites here)
 * ---------------------------------------------------------------------------
 * It esbuilds the CURRENT extensions/pi-plan/index.ts into an OS temp dir at run time (never a stale
 * bundled copy), aliasing typebox + @earendil-works/pi-coding-agent to tiny local stubs (so
 * it runs from a clean checkout with no `npm install`), imports the built ESM, and drives
 * the REAL registered command (/plan), the REAL submit_plan tool, and the REAL tool_call /
 * session_start handlers against a mocked pi/ctx. It asserts the OBSERVABLE contract
 * (gate-armed-or-not via a real tool_call, persisted plan-state, re-injected messages, tool
 * result details) — never a copy of internals — so it tracks the source.
 *
 * Run it:    node extensions/pi-plan/tests/integration/plan-approval.test.mjs
 * Exit code: 0 = all checks passed; 1 = a behavioral check failed; 2 = harness crashed.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExtension, createChecker, loadDefault, sdkStub } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// extensions/pi-plan/tests/integration/ -> repo root is four levels up.
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

// ---------------------------------------------------------------------------
// Assertion harness
// ---------------------------------------------------------------------------
const { check, counts } = createChecker();

// ---------------------------------------------------------------------------
// Build the current extensions/pi-plan/index.ts to ESM in a temp dir, return import URL.
// ---------------------------------------------------------------------------
async function buildPlan() {
	// plan.ts only needs Type.* for tool-schema declaration (never validation) and
	// CONFIG_DIR_NAME/getAgentDir for parity with the family.
	return await buildExtension({
		name: "pi-plan-approval-integration",
		src: path.join(REPO_ROOT, "extensions", "pi-plan", "index.ts"),
		outName: "plan.mjs",
		stubs: { typebox: true, sdk: (dir) => sdkStub(dir) },
		npx: "--yes",
	});
}

// plan.ts keeps a module singleton (activePlans). loadDefault's cache-busting query
// gives each scenario a FRESH instance so scenarios never leak state into each other.

// ---------------------------------------------------------------------------
// Mock pi + ctx (shape mirrors the ExtensionAPI / ExtensionContext surface plan.ts uses).
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

// confirmResult can be a boolean or a queue (array) consumed FIFO across submit_plan calls,
// so one scenario can REJECT then APPROVE the next submission (the revise→resubmit path).
function makeCtx({ mode = "tui", hasUI = true, confirmResult = true, cwd = REPO_ROOT, entries = [] } = {}) {
	const notes = [];
	const ctx = {
		mode,
		hasUI,
		cwd,
		isIdle: () => true,
		isProjectTrusted: () => true,
		getContextUsage: () => undefined,
		ui: {
			theme: { fg: (_c, s) => s },
			notify: (msg, type) => notes.push({ msg, type }),
			setStatus: () => {},
			confirm: async () => {
				const r = ctx._confirmResult;
				if (Array.isArray(r)) return r.shift();
				if (typeof r === "function") return r();
				return r;
			},
			select: async () => undefined,
		},
		sessionManager: { getEntries: () => entries },
	};
	ctx._confirmResult = confirmResult;
	ctx._notes = notes;
	return ctx;
}

function deferred() {
	let resolve;
	const promise = new Promise((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

function toolCallEvent(toolName, input = {}) {
	return {
		type: "tool_call",
		toolCallId: `tc-${Math.random().toString(16).slice(2)}`,
		toolName,
		input,
	};
}

// Run every registered tool_call handler; first blocker wins (mirrors the engine).
async function runGate(handlers, ctx, event) {
	for (const h of handlers.get("tool_call") || []) {
		const res = await h(event, ctx);
		if (res?.block) return res;
	}
	return undefined;
}

// Convenience: is a `write` mutation currently BLOCKED by the armed gate?
async function writeBlocked(handlers, ctx) {
	const r = await runGate(handlers, ctx, toolCallEvent("write", { file_path: "a.ts", content: "x" }));
	return !!r && r.block === true;
}

// The latest persisted plan-state snapshot (last appendEntry wins), or undefined.
function latestPlanState(entries) {
	let latest;
	for (const e of entries) if (e.customType === "plan-state") latest = e.data;
	return latest;
}

// Fire a session_start with the given reason against all registered handlers.
async function fireSessionStart(handlers, ctx, reason = "resume") {
	for (const h of handlers.get("session_start") || []) await h({ reason }, ctx);
}

// ===========================================================================
// SCENARIO 1: APPROVE lifts the gate, persists approved, and re-injects implement.
// ===========================================================================
async function approveLiftsGate(url) {
	const planExtension = await loadDefault(url);
	const { pi, commands, tools, handlers, entries, sentMessages } = makePi();
	planExtension(pi);
	const ctx = makeCtx({ mode: "tui", hasUI: true, confirmResult: true });

	await commands.get("plan").handler("design a feature", ctx);
	// While planning, the gate is armed: a write is blocked.
	check("approve: write BLOCKED while planning", await writeBlocked(handlers, ctx));

	// The planning prompt was injected on entry (1 message so far).
	const beforeSubmit = sentMessages.length;
	check(
		"approve: planning prompt injected on entry",
		beforeSubmit === 1 && /PLAN MODE/i.test(sentMessages[0].content),
	);
	// The planning prompt tells the model its PLAN may run dynamic workflows after approval
	// (so it knows the option exists when designing the implementation, not just that the tool
	// is read-only while planning).
	check(
		"approve: planning prompt advertises dynamic workflows in the plan",
		/your plan may include running dynamic workflows/i.test(sentMessages[0].content) &&
			/after (the user )?approv/i.test(sentMessages[0].content),
	);

	const planText = "# Plan\n1. Do the thing\n2. Verify it";
	const submit = tools.get("submit_plan");
	check("submit_plan tool registered", !!submit);
	const res = await submit.execute("tc1", { plan: planText }, undefined, undefined, ctx);

	// Observable: gate LIFTED — the same write is now ALLOWED.
	check("approve: write ALLOWED after approval (gate lifted)", !(await writeBlocked(handlers, ctx)));

	// Observable: persisted terminal state is approved + inactive.
	const st = latestPlanState(entries);
	check("approve: persisted status=approved", st && st.status === "approved");
	check("approve: persisted active=false", st && st.active === false);
	check("approve: submissions counted (1)", st && st.submissions === 1);
	check("approve: no rejections", st && st.rejections === 0);

	// Observable: implementation message re-injected, carrying the EXACT plan text.
	const wake = sentMessages[sentMessages.length - 1];
	check("approve: implement message re-injected after approval", sentMessages.length === beforeSubmit + 1);
	check("approve: implement message says 'Implement now'", wake && /Implement now/i.test(wake.content));
	check("approve: implement message contains the plan text verbatim", wake?.content.includes(planText));

	// Observable: tool result reports approved.
	check("approve: tool result details.status=approved", res?.details && res.details.status === "approved");
	check("approve: tool result is not an error", !res?.details?.isError);
}

// ===========================================================================
// SCENARIO 2: REJECT keeps the gate armed, does NOT wake, counts the rejection;
// a follow-up APPROVE then works (the revise → resubmit → approve lifecycle).
// ===========================================================================
async function rejectKeepsGateThenApprove(url) {
	const planExtension = await loadDefault(url);
	const { pi, commands, tools, handlers, entries, sentMessages } = makePi();
	planExtension(pi);
	// First confirm REJECT, second confirm APPROVE.
	const ctx = makeCtx({ mode: "tui", hasUI: true, confirmResult: [false, true] });

	await commands.get("plan").handler("design a feature", ctx);
	const afterEntry = sentMessages.length; // planning prompt
	const submit = tools.get("submit_plan");

	// --- First submission: REJECTED ---
	const planV1 = "# Plan v1\nBad idea";
	const rejRes = await submit.execute("tc1", { plan: planV1 }, undefined, undefined, ctx);

	// Observable: gate STILL armed — a write is still blocked.
	check("reject: write STILL BLOCKED after rejection (gate not lifted)", await writeBlocked(handlers, ctx));
	// Observable: NO implementation message was injected by the rejection.
	check("reject: no implement message injected on rejection", sentMessages.length === afterEntry);
	// Observable: persisted state stays active and planning, with a rejection counted.
	const stRej = latestPlanState(entries);
	check("reject: persisted active=true after rejection", stRej && stRej.active === true);
	check("reject: persisted status=planning after rejection", stRej && stRej.status === "planning");
	check("reject: rejections counted (1)", stRej && stRej.rejections === 1);
	check("reject: submissions counted (1)", stRej && stRej.submissions === 1);
	// Observable: tool result reports rejected and returns guidance to the model.
	check("reject: tool result details.status=rejected", rejRes?.details && rejRes.details.status === "rejected");
	const rejText = rejRes?.content?.[0]?.text;
	check(
		"reject: tool result tells model to revise + resubmit",
		!!rejText && /revise/i.test(rejText) && /submit_plan/i.test(rejText),
	);

	// --- Second submission: APPROVED (revise → resubmit → approve) ---
	const planV2 = "# Plan v2\nGood idea\n1. step";
	const okRes = await submit.execute("tc2", { plan: planV2 }, undefined, undefined, ctx);

	check("reject→approve: write ALLOWED after the eventual approval", !(await writeBlocked(handlers, ctx)));
	const stOk = latestPlanState(entries);
	check("reject→approve: persisted status=approved", stOk && stOk.status === "approved");
	check("reject→approve: persisted active=false", stOk && stOk.active === false);
	check("reject→approve: submissions counted (2)", stOk && stOk.submissions === 2);
	check("reject→approve: rejections retained (1)", stOk && stOk.rejections === 1);
	// Observable: implement message now injected, carrying the SECOND (approved) plan text.
	const wake = sentMessages[sentMessages.length - 1];
	check("reject→approve: implement message injected exactly once", sentMessages.length === afterEntry + 1);
	check("reject→approve: implement message carries the approved (v2) plan", wake?.content.includes(planV2));
	check(
		"reject→approve: implement message does NOT carry the rejected (v1) plan",
		wake && !wake.content.includes(planV1),
	);
	check("reject→approve: tool result details.status=approved", okRes?.details && okRes.details.status === "approved");
}

// ===========================================================================
// SCENARIO 3: /plan exit aborts — lifts the gate, status=exited, NO implement wake.
// ===========================================================================
async function exitAborts(url) {
	const planExtension = await loadDefault(url);
	const { pi, commands, handlers, entries, sentMessages } = makePi();
	planExtension(pi);
	const ctx = makeCtx({ mode: "tui", hasUI: true });

	await commands.get("plan").handler("design a feature", ctx);
	check("exit: write BLOCKED while planning", await writeBlocked(handlers, ctx));
	const afterEntry = sentMessages.length; // planning prompt only

	await commands.get("plan").handler("exit", ctx);

	// Observable: gate lifted.
	check("exit: write ALLOWED after /plan exit (gate lifted)", !(await writeBlocked(handlers, ctx)));
	// Observable: persisted terminal state is exited + inactive.
	const st = latestPlanState(entries);
	check("exit: persisted status=exited", st && st.status === "exited");
	check("exit: persisted active=false", st && st.active === false);
	// Observable (the dangerous direction): exit must NOT re-inject an implementation message.
	check("exit: NO implement message injected (no implicit implement)", sentMessages.length === afterEntry);
	check("exit: no message says 'Implement now'", !sentMessages.some((m) => /Implement now/i.test(m.content)));

	// /plan cancel behaves the same on a freshly re-entered plan (control for the alias).
	await commands.get("plan").handler("another task", ctx);
	check("cancel: write BLOCKED while planning (re-entered)", await writeBlocked(handlers, ctx));
	const before2 = sentMessages.length;
	await commands.get("plan").handler("cancel", ctx);
	check("cancel: write ALLOWED after /plan cancel", !(await writeBlocked(handlers, ctx)));
	check("cancel: NO implement message injected", sentMessages.length === before2);
	const st2 = latestPlanState(entries);
	check("cancel: persisted status=exited", st2 && st2.status === "exited");
}

// ===========================================================================
// SCENARIO 4: submit_plan with NO active plan → isError, no crash, no state change.
// ===========================================================================
async function submitWithNoActivePlan(url) {
	const planExtension = await loadDefault(url);
	const { pi, tools, entries, sentMessages } = makePi();
	planExtension(pi);
	const ctx = makeCtx({ mode: "tui", hasUI: true });

	const submit = tools.get("submit_plan");
	const res = await submit.execute("tc", { plan: "# orphan plan" }, undefined, undefined, ctx);
	check("no-plan: tool result is an error", res?.details && res.details.isError === true);
	check("no-plan: no plan-state persisted", entries.find((e) => e.customType === "plan-state") === undefined);
	check("no-plan: no message injected", sentMessages.length === 0);
}

// ===========================================================================
// SCENARIO 5: rehydrate after reload (session_start) re-arms the gate for an ACTIVE
// plan, leaves TERMINAL plans inert, last-wins by planId, fork is a no-op, and does
// NOT re-inject the planning prompt.
// ===========================================================================
async function rehydrateReArmsActiveOnly(url) {
	// --- 5a: an ACTIVE persisted plan re-arms the gate on reload. ---
	{
		const planExtension = await loadDefault(url);
		const { pi, handlers, sentMessages } = makePi();
		planExtension(pi);
		const persisted = [
			{
				type: "custom",
				customType: "plan-state",
				data: {
					planId: "aaaa1111",
					task: "resumed task",
					active: true,
					status: "planning",
					submissions: 0,
					rejections: 0,
					startedAt: Date.now() - 1000,
					updatedAt: new Date(Date.now() - 1000).toISOString(),
				},
			},
		];
		const ctx = makeCtx({ mode: "tui", hasUI: true, entries: persisted });
		// Before rehydrate, this fresh process has no active plan -> gate inert.
		check("rehydrate(active): gate inert before session_start", !(await writeBlocked(handlers, ctx)));
		await fireSessionStart(handlers, ctx, "resume");
		// After rehydrate, the gate is re-armed -> the write is blocked again.
		check("rehydrate(active): write BLOCKED after reload (gate re-armed)", await writeBlocked(handlers, ctx));
		// Rehydrate must NOT re-inject the planning prompt (the conversation already carries it).
		check("rehydrate(active): does NOT re-inject planning prompt", sentMessages.length === 0);
	}

	// --- 5b: a TERMINAL persisted plan (approved) does NOT re-arm the gate. ---
	{
		const planExtension = await loadDefault(url);
		const { pi, handlers } = makePi();
		planExtension(pi);
		const persisted = [
			{
				type: "custom",
				customType: "plan-state",
				data: {
					planId: "bbbb2222",
					task: "finished task",
					active: false,
					status: "approved",
					submissions: 1,
					rejections: 0,
					startedAt: Date.now() - 2000,
					updatedAt: new Date(Date.now() - 2000).toISOString(),
				},
			},
		];
		const ctx = makeCtx({ mode: "tui", hasUI: true, entries: persisted });
		await fireSessionStart(handlers, ctx, "resume");
		check("rehydrate(terminal-approved): gate stays INERT (write allowed)", !(await writeBlocked(handlers, ctx)));
	}

	// --- 5c: a TERMINAL persisted plan (exited) does NOT re-arm the gate. ---
	{
		const planExtension = await loadDefault(url);
		const { pi, handlers } = makePi();
		planExtension(pi);
		const persisted = [
			{
				type: "custom",
				customType: "plan-state",
				data: {
					planId: "cccc3333",
					task: "aborted task",
					active: false,
					status: "exited",
					submissions: 0,
					rejections: 0,
					startedAt: Date.now() - 3000,
					updatedAt: new Date(Date.now() - 3000).toISOString(),
				},
			},
		];
		const ctx = makeCtx({ mode: "tui", hasUI: true, entries: persisted });
		await fireSessionStart(handlers, ctx, "resume");
		check("rehydrate(terminal-exited): gate stays INERT (write allowed)", !(await writeBlocked(handlers, ctx)));
	}

	// --- 5d: last-wins by planId — a later terminal snapshot for the SAME plan beats an
	//         earlier active one (a plan that was active, then approved, then reloaded). ---
	{
		const planExtension = await loadDefault(url);
		const { pi, handlers } = makePi();
		planExtension(pi);
		const persisted = [
			{
				type: "custom",
				customType: "plan-state",
				data: {
					planId: "dddd4444",
					task: "t",
					active: true,
					status: "planning",
					submissions: 0,
					rejections: 0,
					startedAt: 1,
					updatedAt: "1970-01-01T00:00:01.000Z",
				},
			},
			{
				type: "custom",
				customType: "plan-state",
				data: {
					planId: "dddd4444",
					task: "t",
					active: false,
					status: "approved",
					submissions: 1,
					rejections: 0,
					startedAt: 1,
					updatedAt: "1970-01-01T00:00:02.000Z",
				},
			},
		];
		const ctx = makeCtx({ mode: "tui", hasUI: true, entries: persisted });
		await fireSessionStart(handlers, ctx, "resume");
		check(
			"rehydrate(last-wins terminal): gate INERT (later approved beats earlier active)",
			!(await writeBlocked(handlers, ctx)),
		);
	}

	// --- 5e: last-wins by planId the OTHER direction — a later ACTIVE snapshot for the SAME
	//         plan beats an earlier terminal one (defensive: would re-arm). ---
	{
		const planExtension = await loadDefault(url);
		const { pi, handlers } = makePi();
		planExtension(pi);
		const persisted = [
			{
				type: "custom",
				customType: "plan-state",
				data: {
					planId: "eeee5555",
					task: "t",
					active: false,
					status: "exited",
					submissions: 0,
					rejections: 0,
					startedAt: 1,
					updatedAt: "1970-01-01T00:00:01.000Z",
				},
			},
			{
				type: "custom",
				customType: "plan-state",
				data: {
					planId: "eeee5555",
					task: "t",
					active: true,
					status: "planning",
					submissions: 0,
					rejections: 0,
					startedAt: 1,
					updatedAt: "1970-01-01T00:00:02.000Z",
				},
			},
		];
		const ctx = makeCtx({ mode: "tui", hasUI: true, entries: persisted });
		await fireSessionStart(handlers, ctx, "resume");
		check(
			"rehydrate(last-wins active): write BLOCKED (later active beats earlier terminal)",
			await writeBlocked(handlers, ctx),
		);
	}

	// --- 5f: fork is a no-op — an ACTIVE persisted plan is NOT migrated into a forked session. ---
	{
		const planExtension = await loadDefault(url);
		const { pi, handlers } = makePi();
		planExtension(pi);
		const persisted = [
			{
				type: "custom",
				customType: "plan-state",
				data: {
					planId: "ffff6666",
					task: "t",
					active: true,
					status: "planning",
					submissions: 0,
					rejections: 0,
					startedAt: 1,
					updatedAt: "1970-01-01T00:00:01.000Z",
				},
			},
		];
		const ctx = makeCtx({ mode: "tui", hasUI: true, entries: persisted });
		await fireSessionStart(handlers, ctx, "fork");
		check(
			"rehydrate(fork): gate NOT armed (plan mode not migrated to a fork)",
			!(await writeBlocked(handlers, ctx)),
		);
	}

	// --- 5f2: session_start(fork) also clears any already-live in-memory plan state. ---
	{
		const planExtension = await loadDefault(url);
		const { pi, commands, handlers } = makePi();
		planExtension(pi);
		const ctx = makeCtx({ mode: "tui", hasUI: true });
		await commands.get("plan").handler("parent task", ctx);
		check("rehydrate(fork live): gate BLOCKED before fork boundary", await writeBlocked(handlers, ctx));
		await fireSessionStart(handlers, ctx, "fork");
		check("rehydrate(fork live): gate CLEARED at fork boundary", !(await writeBlocked(handlers, ctx)));
	}

	// --- 5g: junk / foreign / malformed entries are ignored without crashing, and a single
	//         valid active plan among them still re-arms. ---
	{
		const planExtension = await loadDefault(url);
		const { pi, handlers } = makePi();
		planExtension(pi);
		const persisted = [
			{ type: "custom", customType: "loop-state", data: { loopId: "x", status: "running" } }, // foreign type
			{ type: "custom", customType: "plan-state", data: null }, // malformed
			{ type: "custom", customType: "plan-state", data: { task: "no id" } }, // missing planId
			{ type: "message", data: { role: "user" } }, // non-custom
			{
				type: "custom",
				customType: "plan-state",
				data: {
					planId: "9999aaaa",
					task: "t",
					active: true,
					status: "planning",
					submissions: 0,
					rejections: 0,
					startedAt: 1,
					updatedAt: "1970-01-01T00:00:01.000Z",
				},
			},
		];
		const ctx = makeCtx({ mode: "tui", hasUI: true, entries: persisted });
		await fireSessionStart(handlers, ctx, "resume"); // must not throw
		check("rehydrate(junk): valid active plan among junk re-arms the gate", await writeBlocked(handlers, ctx));
	}
}

// ===========================================================================
// SCENARIO 6: a pending approval result is stale if plan mode was exited or replaced.
// ===========================================================================
async function pendingConfirmCannotOverrideCurrentPlan(url) {
	// --- 6a: /plan exit while confirm is pending wins; late APPROVE does not wake. ---
	{
		const planExtension = await loadDefault(url);
		const { pi, commands, tools, handlers, entries, sentMessages } = makePi();
		planExtension(pi);
		const gate = deferred();
		const ctx = makeCtx({ mode: "tui", hasUI: true, confirmResult: () => gate.promise });

		await commands.get("plan").handler("design a feature", ctx);
		const afterEntry = sentMessages.length;
		const pending = tools.get("submit_plan").execute("tc1", { plan: "# Late plan" }, undefined, undefined, ctx);
		check("pending-exit: write BLOCKED while approval is pending", await writeBlocked(handlers, ctx));

		await commands.get("plan").handler("exit", ctx);
		check("pending-exit: write ALLOWED immediately after /plan exit", !(await writeBlocked(handlers, ctx)));
		const exited = latestPlanState(entries);
		check("pending-exit: persisted status=exited before late confirm", exited && exited.status === "exited");

		gate.resolve(true);
		const res = await pending;
		check(
			"pending-exit: late approval returns stale error",
			res?.details && res.details.isError === true && res.details.status === "stale",
		);
		check("pending-exit: late approval does NOT inject implement", sentMessages.length === afterEntry);
		check(
			"pending-exit: no message says 'Implement now'",
			!sentMessages.some((m) => /Implement now/i.test(m.content)),
		);
		check("pending-exit: gate remains ALLOWED after stale approval", !(await writeBlocked(handlers, ctx)));
	}

	// --- 6b: if a new plan is started while the old confirm is pending, the old result is stale. ---
	{
		const planExtension = await loadDefault(url);
		const { pi, commands, tools, handlers, entries, sentMessages } = makePi();
		planExtension(pi);
		const gate = deferred();
		const ctx = makeCtx({ mode: "tui", hasUI: true, confirmResult: () => gate.promise });

		await commands.get("plan").handler("old task", ctx);
		const afterOldEntry = sentMessages.length;
		const pending = tools.get("submit_plan").execute("tc1", { plan: "# Old plan" }, undefined, undefined, ctx);
		await commands.get("plan").handler("cancel", ctx);
		await commands.get("plan").handler("new task", ctx);
		check("pending-replaced: new plan re-arms gate", await writeBlocked(handlers, ctx));

		gate.resolve(true);
		const res = await pending;
		check(
			"pending-replaced: old approval returns stale error",
			res?.details && res.details.isError === true && res.details.status === "stale",
		);
		check("pending-replaced: old approval does NOT inject implement", sentMessages.length === afterOldEntry + 1);
		const st = latestPlanState(entries);
		check(
			"pending-replaced: latest state is the new active plan",
			st && st.active === true && st.status === "planning" && st.task === "new task",
		);
		check("pending-replaced: gate remains BLOCKED for the new plan", await writeBlocked(handlers, ctx));
	}

	// --- 6c: two overlapping submissions in the same plan: only the latest approval may apply. ---
	{
		const planExtension = await loadDefault(url);
		const { pi, commands, tools, handlers, entries, sentMessages } = makePi();
		planExtension(pi);
		const first = deferred();
		const second = deferred();
		const confirmations = [first.promise, second.promise];
		const ctx = makeCtx({ mode: "tui", hasUI: true, confirmResult: () => confirmations.shift() });

		await commands.get("plan").handler("design a feature", ctx);
		const afterEntry = sentMessages.length;
		const oldPending = tools.get("submit_plan").execute("tc1", { plan: "# Old plan" }, undefined, undefined, ctx);
		const latestPending = tools
			.get("submit_plan")
			.execute("tc2", { plan: "# New plan" }, undefined, undefined, ctx);
		check("pending-overlap: gate remains BLOCKED while approvals are pending", await writeBlocked(handlers, ctx));

		first.resolve(true);
		const oldRes = await oldPending;
		check(
			"pending-overlap: older approval returns stale error",
			oldRes?.details && oldRes.details.isError === true && oldRes.details.status === "stale",
		);
		check("pending-overlap: older approval does NOT inject implement", sentMessages.length === afterEntry);
		check("pending-overlap: gate remains BLOCKED after stale older approval", await writeBlocked(handlers, ctx));

		second.resolve(true);
		const latestRes = await latestPending;
		check(
			"pending-overlap: latest approval succeeds",
			latestRes?.details && latestRes.details.status === "approved",
		);
		check("pending-overlap: latest approval injects implement once", sentMessages.length === afterEntry + 1);
		const wake = sentMessages[sentMessages.length - 1];
		check(
			"pending-overlap: implementation uses latest plan text",
			wake?.content.includes("# New plan") && !wake.content.includes("# Old plan"),
		);
		const st = latestPlanState(entries);
		check(
			"pending-overlap: latest state approved and inactive",
			st && st.active === false && st.status === "approved" && st.submissions === 2,
		);
		check("pending-overlap: gate ALLOWED after latest approval", !(await writeBlocked(handlers, ctx)));
	}
}

// ===========================================================================
// SCENARIO 7: AUTONOMOUS ENTRY via the model-callable enter_plan_mode tool.
//
// The whole point of this feature: Pi can arm plan mode ITSELF ("cuando le parezca"),
// not only when a human types /plan. The tool must reach the SAME armed/persisted state
// as the command, hand the planning instruction back through its OWN result (so the model
// keeps planning in the same turn — no second user message / double injection), REFUSE in
// non-interactive modes (no approval handshake possible), be an idempotent no-op when a
// plan is already active, and then plug into the UNCHANGED submit_plan approval handshake.
// ===========================================================================
async function autonomousEntryViaTool(url) {
	// --- 7a: tui → enter_plan_mode arms the read-only gate + persists planning, and hands
	//          the planning instruction back AS THE TOOL RESULT (not via a wake message). ---
	{
		const planExtension = await loadDefault(url);
		const { pi, tools, handlers, entries, sentMessages } = makePi();
		planExtension(pi);
		const ctx = makeCtx({ mode: "tui", hasUI: true });

		const enter = tools.get("enter_plan_mode");
		check("enter: enter_plan_mode tool registered", !!enter);
		check(
			"enter: tool exposes a non-empty promptSnippet",
			!!enter && typeof enter.promptSnippet === "string" && enter.promptSnippet.length > 0,
		);
		check(
			"enter: tool exposes non-empty promptGuidelines (so the model learns WHEN to use it)",
			!!enter && Array.isArray(enter.promptGuidelines) && enter.promptGuidelines.length > 0,
		);

		// Before entry, a write is ALLOWED (gate not armed).
		check("enter: write ALLOWED before enter_plan_mode", !(await writeBlocked(handlers, ctx)));

		const res = await enter.execute("tc1", { task: "refactor the auth module" }, undefined, undefined, ctx);

		// Observable: gate ARMED — the same write is now BLOCKED.
		check("enter: write BLOCKED after enter_plan_mode (gate armed)", await writeBlocked(handlers, ctx));
		// Observable: persisted ACTIVE planning state (same shape the command produces).
		const st = latestPlanState(entries);
		check("enter: persisted active=true", st && st.active === true);
		check("enter: persisted status=planning", st && st.status === "planning");
		check("enter: persisted task carried verbatim", st && st.task === "refactor the auth module");
		// Observable: the tool result reports entered + carries the PLAN MODE instruction to the model.
		check("enter: tool result details.entered=true", res?.details && res.details.entered === true);
		const text = res?.content?.[0]?.text;
		check(
			"enter: tool result carries the planning instruction (PLAN MODE + submit_plan)",
			!!text && /PLAN MODE/i.test(text) && /submit_plan/i.test(text),
		);
		// Observable: NO extra user message injected — the instruction rides the tool result.
		check("enter: no user message injected by the tool (no double injection)", sentMessages.length === 0);
	}

	// --- 7b: print → enter_plan_mode REFUSES; the gate is NEVER armed (no approval possible). ---
	{
		const planExtension = await loadDefault(url);
		const { pi, tools, handlers, entries } = makePi();
		planExtension(pi);
		const ctx = makeCtx({ mode: "print", hasUI: false });
		const logged = [];
		const origLog = console.log;
		console.log = (...a) => logged.push(a.join(" "));
		let res;
		try {
			res = await tools.get("enter_plan_mode").execute("tc1", { task: "do a thing" }, undefined, undefined, ctx);
		} finally {
			console.log = origLog;
		}
		check("enter(print): tool result details.entered=false", res?.details && res.details.entered === false);
		check(
			"enter(print): no plan-state persisted",
			entries.find((e) => e.customType === "plan-state") === undefined,
		);
		check("enter(print): write ALLOWED (gate never armed)", !(await writeBlocked(handlers, ctx)));
	}

	// --- 7c: idempotent no-op when a plan is already active (no SECOND plan created). ---
	{
		const planExtension = await loadDefault(url);
		const { pi, commands, tools, entries } = makePi();
		planExtension(pi);
		const ctx = makeCtx({ mode: "tui", hasUI: true });
		await commands.get("plan").handler("first task", ctx);
		const firstState = latestPlanState(entries);
		const res = await tools
			.get("enter_plan_mode")
			.execute("tc1", { task: "second task" }, undefined, undefined, ctx);
		check("enter(active): tool result details.entered=false", res?.details && res.details.entered === false);
		check("enter(active): reason=already-active", res?.details && res.details.reason === "already-active");
		const lastState = latestPlanState(entries);
		check(
			"enter(active): no second plan created (planId unchanged)",
			lastState && firstState && lastState.planId === firstState.planId,
		);
	}

	// --- 7d: end-to-end — autonomous entry plugs into the UNCHANGED submit_plan handshake. ---
	{
		const planExtension = await loadDefault(url);
		const { pi, tools, handlers, sentMessages } = makePi();
		planExtension(pi);
		const ctx = makeCtx({ mode: "tui", hasUI: true, confirmResult: true });
		await tools.get("enter_plan_mode").execute("tc1", { task: "ship the feature" }, undefined, undefined, ctx);
		check("enter→approve: write BLOCKED while planning", await writeBlocked(handlers, ctx));
		const planText = "# Plan\n1. step";
		const res = await tools.get("submit_plan").execute("tc2", { plan: planText }, undefined, undefined, ctx);
		check("enter→approve: write ALLOWED after approval (gate lifted)", !(await writeBlocked(handlers, ctx)));
		check("enter→approve: submit_plan status=approved", res?.details && res.details.status === "approved");
		const wake = sentMessages[sentMessages.length - 1];
		check(
			"enter→approve: implement message injected with the plan text",
			wake && /Implement now/i.test(wake.content) && wake.content.includes(planText),
		);
	}
}

// ===========================================================================
// SCENARIO 8: NON-INTERACTIVE plan-only mode (print/json — e.g. a workflow subagent).
// Opt-in via the nonInteractive param OR PI_PLAN_NONINTERACTIVE=1. The gate arms,
// submit_plan returns the plan as the DELIVERABLE, the gate STAYS armed (never lifts
// without a human), and NO implement message is injected. Param beats env; default off.
// ===========================================================================
async function nonInteractivePlanOnly(url) {
	// --- 8a: enter via env in json mode → arms gate; submit_plan is plan-only. ---
	{
		const planExtension = await loadDefault(url);
		const { pi, tools, handlers, entries, sentMessages } = makePi();
		planExtension(pi);
		const ctx = makeCtx({ mode: "json", hasUI: false });
		process.env.PI_PLAN_NONINTERACTIVE = "1";
		try {
			const enterRes = await tools
				.get("enter_plan_mode")
				.execute("tc1", { task: "plan via workflow subagent" }, undefined, undefined, ctx);
			check("plan-only(env): entered=true in json mode", enterRes?.details && enterRes.details.entered === true);
			check("plan-only(env): write BLOCKED after entry (gate armed)", await writeBlocked(handlers, ctx));
			const st0 = latestPlanState(entries);
			check("plan-only(env): persisted nonInteractive=true", st0 && st0.nonInteractive === true);
			check(
				"plan-only(env): planning prompt marks NON-INTERACTIVE",
				/NON-INTERACTIVE/i.test(enterRes.content[0].text),
			);

			const planText = "# Plan\n1. do X\n2. verify";
			const submitRes = await tools
				.get("submit_plan")
				.execute("tc2", { plan: planText }, undefined, undefined, ctx);
			check(
				"plan-only(env): submit details.status=plan-only",
				submitRes?.details && submitRes.details.status === "plan-only",
			);
			check(
				"plan-only(env): submit returns the plan text as the deliverable",
				submitRes.content[0].text.includes(planText),
			);
			check(
				"plan-only(env): write STILL BLOCKED after submit (gate not lifted)",
				await writeBlocked(handlers, ctx),
			);
			check("plan-only(env): NO implement message injected", sentMessages.length === 0);
			const st = latestPlanState(entries);
			check("plan-only(env): persisted status=planned", st && st.status === "planned");
			check("plan-only(env): persisted active=true (gate persists for the session)", st && st.active === true);
		} finally {
			delete process.env.PI_PLAN_NONINTERACTIVE;
		}
	}

	// --- 8b: explicit param wins over env — nonInteractive:false in json REFUSES. ---
	{
		const planExtension = await loadDefault(url);
		const { pi, tools, handlers, entries } = makePi();
		planExtension(pi);
		const ctx = makeCtx({ mode: "json", hasUI: false });
		process.env.PI_PLAN_NONINTERACTIVE = "1";
		try {
			const res = await tools
				.get("enter_plan_mode")
				.execute("tc1", { task: "x", nonInteractive: false }, undefined, undefined, ctx);
			check(
				"plan-only(precedence): param false beats env=1 → refuses",
				res?.details && res.details.entered === false && res.details.reason === "mode",
			);
			check("plan-only(precedence): gate NOT armed", !(await writeBlocked(handlers, ctx)));
			check(
				"plan-only(precedence): no plan-state persisted",
				entries.find((e) => e.customType === "plan-state") === undefined,
			);
		} finally {
			delete process.env.PI_PLAN_NONINTERACTIVE;
		}
	}

	// --- 8c: default OFF — json without the flag still REFUSES (back-compat). ---
	{
		const planExtension = await loadDefault(url);
		const { pi, tools, handlers } = makePi();
		planExtension(pi);
		const ctx = makeCtx({ mode: "json", hasUI: false });
		const res = await tools.get("enter_plan_mode").execute("tc1", { task: "x" }, undefined, undefined, ctx);
		check("plan-only(default-off): json refuses without the flag", res?.details && res.details.entered === false);
		check("plan-only(default-off): gate NOT armed", !(await writeBlocked(handlers, ctx)));
	}
}

// ===========================================================================
// SCENARIO 9: ULTRACODE posture knobs tune the planning + implement wording.
// ===========================================================================
async function ultracodePromptKnobs(url) {
	// --- 9a: enter_plan_mode with ultracode/ultracodeSteps injects the guidance. ---
	{
		const planExtension = await loadDefault(url);
		const { pi, tools } = makePi();
		planExtension(pi);
		const ctx = makeCtx({ mode: "tui", hasUI: true });
		const res = await tools
			.get("enter_plan_mode")
			.execute("tc1", { task: "ship", ultracode: true, ultracodeSteps: true }, undefined, undefined, ctx);
		const text = res.content[0].text;
		check("ultracode: planning prompt mentions ULTRACODE", /ULTRACODE:/i.test(text));
		check("ultracode: planning prompt mentions ULTRACODE STEPS", /ULTRACODE STEPS/i.test(text));
	}
	// --- 9b: no flags → no ultracode wording (characterization of the default). ---
	{
		const planExtension = await loadDefault(url);
		const { pi, tools } = makePi();
		planExtension(pi);
		const ctx = makeCtx({ mode: "tui", hasUI: true });
		const res = await tools.get("enter_plan_mode").execute("tc1", { task: "ship" }, undefined, undefined, ctx);
		check("ultracode(off): no ULTRACODE STEPS wording by default", !/ULTRACODE STEPS/i.test(res.content[0].text));
	}
	// --- 9c: ultracodeSteps reaches the post-approval implement message. ---
	{
		const planExtension = await loadDefault(url);
		const { pi, tools, sentMessages } = makePi();
		planExtension(pi);
		const ctx = makeCtx({ mode: "tui", hasUI: true, confirmResult: true });
		await tools
			.get("enter_plan_mode")
			.execute("tc1", { task: "ship", ultracodeSteps: true }, undefined, undefined, ctx);
		await tools.get("submit_plan").execute("tc2", { plan: "# Plan\n1. step" }, undefined, undefined, ctx);
		const wake = sentMessages[sentMessages.length - 1];
		check(
			"ultracode-steps: implement message tells to run steps via dynamic_workflow",
			wake && /dynamic_workflow/i.test(wake.content),
		);
	}
}

// ===========================================================================
// SCENARIO 10: /plan dashboard renders a tracking report (non-UI prints the Markdown).
// ===========================================================================
async function planDashboardReport(url) {
	const planExtension = await loadDefault(url);
	const { pi, commands } = makePi();
	planExtension(pi);
	const tuiCtx = makeCtx({ mode: "tui", hasUI: true });
	// Start a plan (with a posture flag) so the dashboard has something to track. The active
	// plan lives in the module's in-memory map, which the dashboard overlays regardless of
	// the (decoupled) session entries in this harness.
	await commands.get("plan").handler("design the dashboard --ultracode-steps", tuiCtx);

	const logged = [];
	const origLog = console.log;
	console.log = (...a) => logged.push(a.join(" "));
	try {
		const printCtx = makeCtx({ mode: "print", hasUI: false });
		await commands.get("plan").handler("dashboard", printCtx);
	} finally {
		console.log = origLog;
	}
	const out = logged.join("\n");
	check("dashboard: prints the dashboard title", /Plan Mode Dashboard/.test(out));
	check("dashboard: lists the active plan task", /design the dashboard/.test(out));
	check("dashboard: shows the ultracode-steps posture", /ultracode-steps/.test(out));
	check("dashboard: renders the History table header", /\| Plan \| Status \| Posture \|/.test(out));
}

// ===========================================================================
// SCENARIO 11: SESSION TOGGLES — /plan ultracode|steps-ultracode on|off|status set the
// in-memory posture default (param -> toggle -> env -> off) for flagless /plan entries.
// ===========================================================================
async function sessionToggles(url) {
	const planExtension = await loadDefault(url);
	const { pi, commands, sentMessages } = makePi();
	planExtension(pi);
	const ctx = makeCtx({ mode: "tui", hasUI: true });

	// Turn both ON, then a FLAGLESS /plan must inherit the ultracode posture.
	await commands.get("plan").handler("ultracode on", ctx);
	check(
		"toggle: /plan ultracode on is acknowledged",
		ctx._notes.some((n) => /ultracode session default: on/i.test(n.msg)),
	);
	await commands.get("plan").handler("steps-ultracode on", ctx);
	await commands.get("plan").handler("build the thing", ctx);
	const prompt = sentMessages[sentMessages.length - 1].content;
	check("toggle: session ultracode applies to a flagless /plan", /ULTRACODE:/i.test(prompt));
	check("toggle: session ultracode-steps applies to a flagless /plan", /ULTRACODE STEPS/i.test(prompt));

	// Exit, turn OFF, then a fresh flagless /plan must have NO ultracode wording.
	await commands.get("plan").handler("exit", ctx);
	await commands.get("plan").handler("ultracode off", ctx);
	await commands.get("plan").handler("steps-ultracode off", ctx);
	await commands.get("plan").handler("another thing", ctx);
	const prompt2 = sentMessages[sentMessages.length - 1].content;
	check("toggle: ultracode off → no ULTRACODE wording", !/ULTRACODE/i.test(prompt2));

	// status reports the current default.
	await commands.get("plan").handler("ultracode status", ctx);
	check(
		"toggle: ultracode status reports off",
		ctx._notes.some((n) => /ultracode session default: off/i.test(n.msg)),
	);
}

// ===========================================================================
// SCENARIO 12: nonInteractive is IGNORED in interactive (tui/rpc) sessions — it must NEVER
// bypass the human approval handshake. A stray param or an exported PI_PLAN_NONINTERACTIVE
// in a TUI must still go through approve/implement, not the plan-only deliverable path.
// ===========================================================================
async function nonInteractiveIgnoredInTui(url) {
	// --- 12a: explicit param nonInteractive:true in TUI is clamped off. ---
	{
		const planExtension = await loadDefault(url);
		const { pi, tools, handlers, entries, sentMessages } = makePi();
		planExtension(pi);
		const ctx = makeCtx({ mode: "tui", hasUI: true, confirmResult: true });
		const enterRes = await tools
			.get("enter_plan_mode")
			.execute("tc1", { task: "x", nonInteractive: true }, undefined, undefined, ctx);
		check("nonInteractive-tui: entered", enterRes?.details && enterRes.details.entered === true);
		const st0 = latestPlanState(entries);
		check("nonInteractive-tui: nonInteractive clamped to false in TUI", st0 && !st0.nonInteractive);
		const res = await tools.get("submit_plan").execute("tc2", { plan: "# P\n1. step" }, undefined, undefined, ctx);
		check(
			"nonInteractive-tui: submit uses interactive approval (status=approved, NOT plan-only)",
			res?.details && res.details.status === "approved",
		);
		check("nonInteractive-tui: gate LIFTED after approval", !(await writeBlocked(handlers, ctx)));
		const wake = sentMessages[sentMessages.length - 1];
		check("nonInteractive-tui: implement message injected", wake && /Implement now/i.test(wake.content));
	}

	// --- 12b: an exported PI_PLAN_NONINTERACTIVE=1 is also ignored in TUI. ---
	{
		const planExtension = await loadDefault(url);
		const { pi, tools, entries } = makePi();
		planExtension(pi);
		const ctx = makeCtx({ mode: "tui", hasUI: true, confirmResult: true });
		process.env.PI_PLAN_NONINTERACTIVE = "1";
		try {
			await tools.get("enter_plan_mode").execute("tc1", { task: "y" }, undefined, undefined, ctx);
			const st = latestPlanState(entries);
			check("nonInteractive-tui: env=1 ignored in TUI (plan stays interactive)", st && !st.nonInteractive);
		} finally {
			delete process.env.PI_PLAN_NONINTERACTIVE;
		}
	}
}

// ===========================================================================
async function main() {
	const { outDir, url } = await buildPlan();
	try {
		await approveLiftsGate(url);
		await rejectKeepsGateThenApprove(url);
		await exitAborts(url);
		await submitWithNoActivePlan(url);
		await rehydrateReArmsActiveOnly(url);
		await pendingConfirmCannotOverrideCurrentPlan(url);
		await autonomousEntryViaTool(url);
		await nonInteractivePlanOnly(url);
		await ultracodePromptKnobs(url);
		await planDashboardReport(url);
		await sessionToggles(url);
		await nonInteractiveIgnoredInTui(url);
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
