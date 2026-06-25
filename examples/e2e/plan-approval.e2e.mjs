/**
 * Durable behavioral e2e for the APPROVAL HANDSHAKE + LIFECYCLE of plan.ts.
 *
 * Why this file exists (and why it is NOT a duplicate of safety-gates)
 * -------------------------------------------------------------------
 * `safety-gates.e2e.mjs` already pins the READ-ONLY GATE of plan.ts: the pure
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
 * How it works (same self-bootstrapping pattern as the other e2e suites here)
 * ---------------------------------------------------------------------------
 * It esbuilds the CURRENT extensions/plan.ts into an OS temp dir at run time (never a stale
 * bundled copy), aliasing typebox + @earendil-works/pi-coding-agent to tiny local stubs (so
 * it runs from a clean checkout with no `npm install`), imports the built ESM, and drives
 * the REAL registered command (/plan), the REAL submit_plan tool, and the REAL tool_call /
 * session_start handlers against a mocked pi/ctx. It asserts the OBSERVABLE contract
 * (gate-armed-or-not via a real tool_call, persisted plan-state, re-injected messages, tool
 * result details) — never a copy of internals — so it tracks the source.
 *
 * Run it:    node examples/e2e/plan-approval.e2e.mjs
 * Exit code: 0 = all checks passed; 1 = a behavioral check failed; 2 = harness crashed.
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
// Build the current extensions/plan.ts to ESM in a temp dir, return import URL.
// ---------------------------------------------------------------------------
async function buildPlan() {
	const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-plan-approval-e2e-"));

	// Tiny stubs for the two external peer packages. plan.ts only needs Type.* for tool-schema
	// declaration (never validation) and CONFIG_DIR_NAME/getAgentDir for parity with the family.
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

	const src = path.join(REPO_ROOT, "extensions", "plan.ts");
	if (!existsSync(src)) throw new Error(`missing source: ${src}`);
	const out = path.join(outDir, "plan.mjs");
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
	if (r.status !== 0) throw new Error(`esbuild failed for plan: ${r.stderr || r.stdout}`);
	return { outDir, url: pathToFileURL(out).href };
}

// plan.ts keeps a module singleton (activePlans). Load a FRESH instance per scenario via a
// cache-busting query so scenarios never leak state into each other.
let _instance = 0;
async function freshDefault(url) {
	const mod = await import(`${url}?i=${_instance++}`);
	return mod.default;
}

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
	const planExtension = await freshDefault(url);
	const { pi, commands, tools, handlers, entries, sentMessages } = makePi();
	planExtension(pi);
	const ctx = makeCtx({ mode: "tui", hasUI: true, confirmResult: true });

	await commands.get("plan").handler("design a feature", ctx);
	// While planning, the gate is armed: a write is blocked.
	check("approve: write BLOCKED while planning", await writeBlocked(handlers, ctx));

	// The planning prompt was injected on entry (1 message so far).
	const beforeSubmit = sentMessages.length;
	check("approve: planning prompt injected on entry", beforeSubmit === 1 && /PLAN MODE/i.test(sentMessages[0].content));

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
	check("approve: implement message contains the plan text verbatim", wake && wake.content.includes(planText));

	// Observable: tool result reports approved.
	check("approve: tool result details.status=approved", res && res.details && res.details.status === "approved");
	check("approve: tool result is not an error", !(res && res.details && res.details.isError));
}

// ===========================================================================
// SCENARIO 2: REJECT keeps the gate armed, does NOT wake, counts the rejection;
// a follow-up APPROVE then works (the revise → resubmit → approve lifecycle).
// ===========================================================================
async function rejectKeepsGateThenApprove(url) {
	const planExtension = await freshDefault(url);
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
	check("reject: tool result details.status=rejected", rejRes && rejRes.details && rejRes.details.status === "rejected");
	const rejText = rejRes && rejRes.content && rejRes.content[0] && rejRes.content[0].text;
	check("reject: tool result tells model to revise + resubmit", !!rejText && /revise/i.test(rejText) && /submit_plan/i.test(rejText));

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
	check("reject→approve: implement message carries the approved (v2) plan", wake && wake.content.includes(planV2));
	check("reject→approve: implement message does NOT carry the rejected (v1) plan", wake && !wake.content.includes(planV1));
	check("reject→approve: tool result details.status=approved", okRes && okRes.details && okRes.details.status === "approved");
}

// ===========================================================================
// SCENARIO 3: /plan exit aborts — lifts the gate, status=exited, NO implement wake.
// ===========================================================================
async function exitAborts(url) {
	const planExtension = await freshDefault(url);
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
	check(
		"exit: no message says 'Implement now'",
		!sentMessages.some((m) => /Implement now/i.test(m.content)),
	);

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
	const planExtension = await freshDefault(url);
	const { pi, tools, entries, sentMessages } = makePi();
	planExtension(pi);
	const ctx = makeCtx({ mode: "tui", hasUI: true });

	const submit = tools.get("submit_plan");
	const res = await submit.execute("tc", { plan: "# orphan plan" }, undefined, undefined, ctx);
	check("no-plan: tool result is an error", res && res.details && res.details.isError === true);
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
		const planExtension = await freshDefault(url);
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
		const planExtension = await freshDefault(url);
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
		const planExtension = await freshDefault(url);
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
		const planExtension = await freshDefault(url);
		const { pi, handlers } = makePi();
		planExtension(pi);
		const persisted = [
			{
				type: "custom",
				customType: "plan-state",
				data: { planId: "dddd4444", task: "t", active: true, status: "planning", submissions: 0, rejections: 0, startedAt: 1, updatedAt: "1970-01-01T00:00:01.000Z" },
			},
			{
				type: "custom",
				customType: "plan-state",
				data: { planId: "dddd4444", task: "t", active: false, status: "approved", submissions: 1, rejections: 0, startedAt: 1, updatedAt: "1970-01-01T00:00:02.000Z" },
			},
		];
		const ctx = makeCtx({ mode: "tui", hasUI: true, entries: persisted });
		await fireSessionStart(handlers, ctx, "resume");
		check("rehydrate(last-wins terminal): gate INERT (later approved beats earlier active)", !(await writeBlocked(handlers, ctx)));
	}

	// --- 5e: last-wins by planId the OTHER direction — a later ACTIVE snapshot for the SAME
	//         plan beats an earlier terminal one (defensive: would re-arm). ---
	{
		const planExtension = await freshDefault(url);
		const { pi, handlers } = makePi();
		planExtension(pi);
		const persisted = [
			{
				type: "custom",
				customType: "plan-state",
				data: { planId: "eeee5555", task: "t", active: false, status: "exited", submissions: 0, rejections: 0, startedAt: 1, updatedAt: "1970-01-01T00:00:01.000Z" },
			},
			{
				type: "custom",
				customType: "plan-state",
				data: { planId: "eeee5555", task: "t", active: true, status: "planning", submissions: 0, rejections: 0, startedAt: 1, updatedAt: "1970-01-01T00:00:02.000Z" },
			},
		];
		const ctx = makeCtx({ mode: "tui", hasUI: true, entries: persisted });
		await fireSessionStart(handlers, ctx, "resume");
		check("rehydrate(last-wins active): write BLOCKED (later active beats earlier terminal)", await writeBlocked(handlers, ctx));
	}

	// --- 5f: fork is a no-op — an ACTIVE persisted plan is NOT migrated into a forked session. ---
	{
		const planExtension = await freshDefault(url);
		const { pi, handlers } = makePi();
		planExtension(pi);
		const persisted = [
			{
				type: "custom",
				customType: "plan-state",
				data: { planId: "ffff6666", task: "t", active: true, status: "planning", submissions: 0, rejections: 0, startedAt: 1, updatedAt: "1970-01-01T00:00:01.000Z" },
			},
		];
		const ctx = makeCtx({ mode: "tui", hasUI: true, entries: persisted });
		await fireSessionStart(handlers, ctx, "fork");
		check("rehydrate(fork): gate NOT armed (plan mode not migrated to a fork)", !(await writeBlocked(handlers, ctx)));
	}

	// --- 5g: junk / foreign / malformed entries are ignored without crashing, and a single
	//         valid active plan among them still re-arms. ---
	{
		const planExtension = await freshDefault(url);
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
				data: { planId: "9999aaaa", task: "t", active: true, status: "planning", submissions: 0, rejections: 0, startedAt: 1, updatedAt: "1970-01-01T00:00:01.000Z" },
			},
		];
		const ctx = makeCtx({ mode: "tui", hasUI: true, entries: persisted });
		await fireSessionStart(handlers, ctx, "resume"); // must not throw
		check("rehydrate(junk): valid active plan among junk re-arms the gate", await writeBlocked(handlers, ctx));
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
	process.exit(0);
}

main().catch((err) => {
	console.error("E2E CRASH:", err && err.stack ? err.stack : err);
	process.exit(2);
});
