/**
 * Durable behavioral integration test for the REHYDRATION (crash/reload recovery) of extensions/pi-goal/index.ts.
 *
 * Why this file exists
 * --------------------
 * `npm test` is a TYPECHECK only (`tsc --noEmit` over the four extensions). It proves the
 * code compiles; it proves NOTHING about runtime behavior. A `/goal` is a PERSISTENT,
 * crash-recoverable agent: when the process restarts, `rehydrate()` (fired on `session_start`)
 * is the ONLY thing that brings a live goal back. Its contract is subtle and entirely
 * behavioral, so a silent regression here is among the most dangerous in the package:
 *
 *   - A goal that crashed mid INDEPENDENT verification (`verifying-independent`) MUST
 *     re-run the skeptical subagent on reload — its in-flight verdict was lost, so we
 *     RE-JUDGE rather than guess. If rehydrate instead dropped it, or closed it as done,
 *     a goal would either silently die or close UNVERIFIED — the precise failure the
 *     independent verifier exists to prevent. (goal.ts rehydrate: the `verifying-independent`
 *     branch calls beginIndependentVerification.)
 *   - A `stale` snapshot (the shape `session_shutdown` writes for a pursuing goal) must
 *     resume as `pursuing` with a single catch-up tick — not a burst of N missed wakes.
 *   - A `verifying` snapshot must resume as `verifying` (the self-check survives a reload).
 *   - TERMINAL snapshots (`done`/`blocked`/`stopped`) must NOT be recovered: a finished
 *     goal must stay finished across a reload (no zombie goals re-arming timers).
 *   - last-wins by goalId across the append-only log; no double-fire if a timer is already
 *     alive in this process; and a `fork` session_start must NOT migrate a running goal.
 *
 * `tsc` sees none of this. This file pins the OBSERVABLE recovery contract.
 *
 * How it works
 * ------------
 * Self-bootstrapping, same proven pattern as safety-gates / goal-verifier integration test: it esbuilds
 * the CURRENT extensions/pi-goal/index.ts into an OS temp dir at run time (never a stale bundled
 * copy), aliasing the two external peer packages (typebox, @earendil-works/pi-coding-agent)
 * to tiny local stubs so it runs from a clean checkout with NO `npm install`. It then drives
 * the REAL registered `session_start` handler against a mocked pi/ctx whose
 * `sessionManager.getEntries()` returns crafted persisted `goal-state` entries — exactly the
 * snapshots `session_shutdown`/persist would have written. It asserts the OBSERVABLE outcome:
 * which goals become active, in which gstatus, whether the verifier subprocess (pi.exec) is
 * re-spawned, and the final persisted disposition. It NEVER copies the rehydrate logic; it
 * tracks the source, so a drift (e.g. recovering a terminal goal, or NOT re-running the
 * verifier) turns this suite red.
 *
 * Run it:
 *   node extensions/pi-goal/tests/integration/goal-rehydrate.test.mjs
 *
 * Exit code 0 = all checks passed; 1 = a behavioral check failed; 2 = harness crashed.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExtension, createChecker, loadDefault, sdkStub } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// extensions/pi-goal/tests/integration/ -> repo root is four levels up.
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

// ---------------------------------------------------------------------------
// Assertion harness
// ---------------------------------------------------------------------------
const { check, counts } = createChecker();

// ---------------------------------------------------------------------------
// Build the current goal extension to ESM in a temp dir, return import URL.
// (Identical stub strategy to the sibling goal-verifier.test.mjs.)
// ---------------------------------------------------------------------------
async function buildGoal() {
	// pi-goal only needs Type.* for tool-schema declaration (never validation) and the SDK
	// symbols for state-dir resolution.
	return await buildExtension({
		name: "pi-goal-rehydrate-integration",
		src: path.join(REPO_ROOT, "extensions", "pi-goal", "index.ts"),
		outName: "goal.mjs",
		stubs: { typebox: true, sdk: (dir) => sdkStub(dir) },
		npx: "--yes",
	});
}

// pi-goal keeps a module singleton (activeGoals). loadDefault's cache-busting query gives
// each scenario a FRESH instance so scenarios never leak goal state into each other.

// Let fire-and-forget async chains (`void beginIndependentVerification(...)`) AND the
// rehydrate catch-up tick settle. rehydrate arms the catch-up wake with `setTimeout(fireGoal, 0)`
// (goal.ts: a due nextFireAt → remaining 0), so each poll iteration must yield to BOTH the timer
// phase (setTimeout) and the check phase (setImmediate). Awaiting setImmediate alone can starve
// the timer phase under load (e.g. when run sequentially via run-all.mjs), which made this suite
// flaky: scenarios B/C (stale/verifying due catch-up) intermittently saw the tick not yet fired.
async function flush(predicate, tries = 100) {
	for (let i = 0; i < tries; i++) {
		await new Promise((r) => setTimeout(r, 0));
		await new Promise((r) => setImmediate(r));
		if (predicate?.()) return;
	}
}

// ---------------------------------------------------------------------------
// Mock pi + ctx. We capture every persisted "goal-state" snapshot (pi.appendEntry), every
// re-injected user message (pi.sendUserMessage), and every verifier subprocess (pi.exec).
// ctx.sessionManager.getEntries() returns the crafted persisted log (the reload input).
// ---------------------------------------------------------------------------
function makePi(execImpl) {
	const tools = new Map();
	const commands = new Map();
	const handlers = new Map();
	const states = []; // every appended goal-state snapshot, in order
	const execCalls = [];
	const messages = [];
	const pi = {
		registerTool: (def) => tools.set(def.name, def),
		registerCommand: (name, opts) => commands.set(name, opts),
		on: (event, handler) => {
			if (!handlers.has(event)) handlers.set(event, []);
			handlers.get(event).push(handler);
		},
		appendEntry: (customType, data) => {
			if (customType === "goal-state") states.push(data);
		},
		sendUserMessage: (prompt, opts) => messages.push({ prompt, opts }),
		exec: async (cmd, args, opts) => {
			execCalls.push({ cmd, args, opts });
			return execImpl ? execImpl(cmd, args, opts) : { code: 0, killed: false, stdout: "", stderr: "" };
		},
	};
	return { pi, tools, commands, handlers, states, execCalls, messages };
}

// A persisted goal-state custom entry, exactly the shape rehydrate() filters on
// (entry.type === "custom" && entry.customType === "goal-state", data = the snapshot).
function entry(snap) {
	return { type: "custom", customType: "goal-state", data: snap };
}

// A minimally-complete GoalState snapshot (the fields rehydrate copies / re-arms on).
let _gid = 0;
function snap(overrides = {}) {
	const goalId = overrides.goalId ?? `g${(_gid++).toString(16).padStart(4, "0")}`;
	return {
		goalId,
		objective: "ship the feature",
		successCriteria: "the tests pass",
		derivedCriteria: undefined,
		iteration: 1,
		maxIterations: 20,
		contextPercentCap: 80,
		assessments: [],
		verifyAttempts: 0,
		independentVerifyAttempts: 0,
		maxIndependentVerifications: 2,
		verifierTimeoutMs: 120000,
		verifierTools: ["read", "grep", "find", "ls", "bash"],
		gstatus: "pursuing",
		startedAt: new Date().toISOString(),
		nextFireAt: Date.now() + 1000,
		lastReason: "persisted snapshot",
		updatedAt: new Date().toISOString(),
		...overrides,
	};
}

function makeCtx(entries, { reason = "startup", mode = "tui" } = {}) {
	return {
		event: { reason },
		ctx: {
			mode,
			hasUI: true,
			cwd: REPO_ROOT,
			isIdle: () => true,
			isProjectTrusted: () => false,
			getContextUsage: () => undefined,
			ui: {
				theme: { fg: (_c, s) => s },
				notify: () => {},
				setStatus: () => {},
				confirm: async () => true,
				select: async () => undefined,
			},
			sessionManager: { getEntries: () => entries },
		},
	};
}

// Build the extension, register it, fire session_start with the crafted persisted entries.
async function rehydrateFrom(goalUrl, entries, { reason = "startup", execImpl, mode = "tui" } = {}) {
	const goalExtension = await loadDefault(goalUrl);
	const built = makePi(execImpl);
	goalExtension(built.pi);
	const onStart = built.handlers.get("session_start");
	if (!onStart || onStart.length === 0) throw new Error("no session_start handler registered");
	const { event, ctx } = makeCtx(entries, { reason, mode });
	for (const h of onStart) await h(event, ctx);
	return { ctx, built };
}

// The last persisted gstatus for a given goalId is its observable disposition.
function lastStatusFor(states, goalId) {
	for (let i = states.length - 1; i >= 0; i--) if (states[i].goalId === goalId) return states[i].gstatus;
	return undefined;
}

// ===========================================================================
// SCENARIO A: a `verifying-independent` snapshot RE-RUNS the independent verifier on reload.
// The most consequential rehydrate path: the lost verdict is re-judged, and its result drives
// the outcome (PASS closes done; the goal is NOT closed without actually re-running the judge).
// ===========================================================================
async function verifyingIndependentReRunsVerifierAndPasses(goalUrl) {
	const s = snap({ gstatus: "verifying-independent", nextFireAt: null });
	const exec = () => ({
		code: 0,
		killed: false,
		stdout: "Criterion 1: PASS.\nVERDICT: PASS",
		stderr: "",
	});
	const { built } = await rehydrateFrom(goalUrl, [entry(s)], { execImpl: exec });
	await flush(() => lastStatusFor(built.states, s.goalId) === "done");
	check(
		"verifying-independent reload RE-SPAWNS the verifier subprocess",
		built.execCalls.length === 1,
		`execCalls=${built.execCalls.length}`,
	);
	check(
		"verifying-independent reload + verifier PASS closes goal (done)",
		lastStatusFor(built.states, s.goalId) === "done",
		`last=${lastStatusFor(built.states, s.goalId)}`,
	);
}

// A re-run verifier that FAILs (under the cap) must NOT close the goal; it iterates back to
// pursuing. (The reload must never produce a false "done".)
async function verifyingIndependentReRunFailDoesNotClose(goalUrl) {
	const s = snap({
		gstatus: "verifying-independent",
		nextFireAt: null,
		independentVerifyAttempts: 0,
	});
	const exec = () => ({
		code: 0,
		killed: false,
		stdout: "Criterion 1: FAIL — no real assertion.\nVERDICT: FAIL",
		stderr: "",
	});
	const { built } = await rehydrateFrom(goalUrl, [entry(s)], { execImpl: exec });
	await flush(() => lastStatusFor(built.states, s.goalId) === "pursuing");
	check(
		"verifying-independent reload + verifier FAIL does NOT close as done",
		!built.states.some((st) => st.goalId === s.goalId && st.gstatus === "done"),
		`last=${lastStatusFor(built.states, s.goalId)}`,
	);
	check(
		"verifying-independent reload + FAIL iterates (continue→pursuing)",
		lastStatusFor(built.states, s.goalId) === "pursuing",
		`last=${lastStatusFor(built.states, s.goalId)}`,
	);
}

// A re-run verifier that FAILs AT the cap must BLOCK (needs a human), never close.
async function verifyingIndependentReRunFailAtCapBlocks(goalUrl) {
	// independentVerifyAttempts already at cap-1 (=1, with max 2): one more FAIL hits the cap.
	const s = snap({
		gstatus: "verifying-independent",
		nextFireAt: null,
		independentVerifyAttempts: 1,
		maxIndependentVerifications: 2,
	});
	const exec = () => ({ code: 0, killed: false, stdout: "VERDICT: FAIL", stderr: "" });
	const { built } = await rehydrateFrom(goalUrl, [entry(s)], { execImpl: exec });
	await flush(() => lastStatusFor(built.states, s.goalId) === "blocked");
	check(
		"verifying-independent reload + FAIL at cap BLOCKS (needs a human)",
		lastStatusFor(built.states, s.goalId) === "blocked",
		`last=${lastStatusFor(built.states, s.goalId)}`,
	);
	check(
		"verifying-independent reload at cap never closes as done",
		!built.states.some((st) => st.goalId === s.goalId && st.gstatus === "done"),
	);
}

// A goal recovered into `verifying-independent` re-runs the verifier OUT of the model turn. If
// the model fires goal_progress while that re-run is in flight, it must be IGNORED (the verdict,
// not the re-entrant report, decides) — otherwise the re-entry would flip gstatus and the
// liveness guard would discard the in-flight verdict (the MEDIO bug, here on the RELOAD path).
// We gate the re-run verifier in flight, poke goal_progress, then release: the verdict closes it.
async function verifyingIndependentReloadIgnoresReentry(goalUrl) {
	let release;
	const gate = new Promise((r) => {
		release = r;
	});
	const exec = async () => {
		await gate;
		return { code: 0, killed: false, stdout: "Criterion 1: PASS.\nVERDICT: PASS", stderr: "" };
	};
	const s = snap({ gstatus: "verifying-independent", nextFireAt: null });
	const { ctx, built } = await rehydrateFrom(goalUrl, [entry(s)], { execImpl: exec });

	// Re-run launched and gated → goal parked in verifying-independent.
	check(
		"reload re-spawns the verifier once (in flight)",
		built.execCalls.length === 1,
		`execCalls=${built.execCalls.length}`,
	);
	check(
		"reloaded goal sits in verifying-independent before re-entry",
		lastStatusFor(built.states, s.goalId) === "verifying-independent",
		`last=${lastStatusFor(built.states, s.goalId)}`,
	);

	const progress = built.tools.get("goal_progress");
	if (!progress) throw new Error("goal_progress tool not registered");
	const r = await progress.execute(
		"tcReload",
		{ status: "done", assessment: "racing the re-run verifier on reload" },
		undefined,
		undefined,
		ctx,
	);
	check(
		"re-entrant goal_progress during reloaded verification is ignored",
		r?.details?.ignored === true,
		JSON.stringify(r?.details),
	);
	check(
		"re-entry does NOT change gstatus (stays verifying-independent)",
		lastStatusFor(built.states, s.goalId) === "verifying-independent",
		`last=${lastStatusFor(built.states, s.goalId)}`,
	);
	check(
		"re-entry does NOT spawn a second verifier",
		built.execCalls.length === 1,
		`execCalls=${built.execCalls.length}`,
	);

	// Release the gated re-run: its PASS — not the discarded re-entry — closes the goal.
	release();
	await flush(() => lastStatusFor(built.states, s.goalId) === "done");
	check(
		"the reloaded verifier's verdict still closes the goal (done)",
		lastStatusFor(built.states, s.goalId) === "done",
		`last=${lastStatusFor(built.states, s.goalId)}`,
	);
}

// The agent_end safety net must NOT re-arm a reloaded verifying-independent goal: its verifier
// runs OUTSIDE the turn and resolves the next transition itself; re-arming would race (and could
// discard) the in-flight verdict. On the RELOAD path `rearmedThisTurn` is false, so the gstatus
// EXCLUSION (goal.ts agent_end) is the SOLE guard here — this is where it is load-bearing.
async function verifyingIndependentReloadSurvivesAgentEnd(goalUrl) {
	let release;
	const gate = new Promise((r) => {
		release = r;
	});
	const exec = async () => {
		await gate;
		return { code: 0, killed: false, stdout: "VERDICT: PASS", stderr: "" };
	};
	const s = snap({ gstatus: "verifying-independent", nextFireAt: null });
	const { ctx, built } = await rehydrateFrom(goalUrl, [entry(s)], { execImpl: exec });
	check(
		"reload parks the goal in verifying-independent (verifier in flight)",
		lastStatusFor(built.states, s.goalId) === "verifying-independent",
		`last=${lastStatusFor(built.states, s.goalId)}`,
	);

	// Fire the safety net while the re-run verifier is mid-flight.
	for (const h of built.handlers.get("agent_end") ?? []) await h({}, ctx);
	check(
		"agent_end does NOT re-arm a reloaded verifying-independent goal",
		!built.states.some((st) => st.goalId === s.goalId && st.lastReason === "auto: turn closed without goal_progress"),
		"unexpected auto re-arm",
	);
	check(
		"agent_end does not spawn a second verifier on reload",
		built.execCalls.length === 1,
		`calls=${built.execCalls.length}`,
	);

	release();
	await flush(() => lastStatusFor(built.states, s.goalId) === "done");
	check(
		"the reloaded verifier's verdict still closes the goal after agent_end (done)",
		lastStatusFor(built.states, s.goalId) === "done",
		`last=${lastStatusFor(built.states, s.goalId)}`,
	);
}

// ===========================================================================
// SCENARIO B: a `stale` snapshot resumes as `pursuing` (the shutdown shape for a pursuing
// goal). rehydrate downgrades stale→pursuing in memory and arms a single catch-up tick. We
// make nextFireAt due (in the past) so that tick fires immediately and proves the goal is
// GENUINELY active again as pursuing: it persists a fresh snapshot with the iteration bumped
// and re-injects ONE pursuing wake — not dropped, not a verifier, not a verifying prompt.
// ===========================================================================
async function staleResumesPursuing(goalUrl) {
	const s = snap({ gstatus: "stale", iteration: 3, nextFireAt: Date.now() - 1000 });
	const { built } = await rehydrateFrom(goalUrl, [entry(s)]);
	// Wait for the catch-up setTimeout(...,0) to fire and persist the next iteration.
	await flush(() => built.states.some((st) => st.goalId === s.goalId && st.iteration > 3));
	const fired = built.states.find((st) => st.goalId === s.goalId && st.iteration > 3);
	check("stale snapshot is recovered (catch-up tick fires)", !!fired, `states=${built.states.length}`);
	check(
		"stale resumes as pursuing (re-armed goal fires in the pursuing phase)",
		!!fired && fired.gstatus === "pursuing",
		`firedStatus=${fired ? fired.gstatus : "<none>"}`,
	);
	check(
		"stale resume re-injects exactly one pursuing wake",
		built.messages.length === 1,
		`messages=${built.messages.length}`,
	);
	check("stale resume does NOT spawn a verifier", built.execCalls.length === 0, `execCalls=${built.execCalls.length}`);
}

// ===========================================================================
// SCENARIO C: a `verifying` snapshot resumes as `verifying` (the self-completeness check
// survives a reload — it is NOT downgraded to pursuing and does NOT spawn the independent
// verifier, which only fires from a CONFIRMED done).
// ===========================================================================
async function verifyingResumesVerifying(goalUrl) {
	// Due catch-up tick: the re-armed goal fires immediately and must fire in the VERIFYING
	// phase (re-injecting the verification prompt), proving the self-check survived the reload.
	const s = snap({ gstatus: "verifying", iteration: 4, nextFireAt: Date.now() - 1000 });
	const { built } = await rehydrateFrom(goalUrl, [entry(s)]);
	await flush(() => built.states.some((st) => st.goalId === s.goalId && st.iteration > 4));
	const fired = built.states.find((st) => st.goalId === s.goalId && st.iteration > 4);
	check("verifying snapshot is recovered (catch-up tick fires)", !!fired, `states=${built.states.length}`);
	check(
		"verifying resumes as verifying (NOT downgraded to pursuing)",
		!!fired && fired.gstatus === "verifying",
		`firedStatus=${fired ? fired.gstatus : "<none>"}`,
	);
	check(
		"verifying resume re-injects exactly one wake",
		built.messages.length === 1,
		`messages=${built.messages.length}`,
	);
	check(
		"verifying snapshot does NOT spawn the independent verifier on reload",
		built.execCalls.length === 0,
		`execCalls=${built.execCalls.length}`,
	);
	check(
		"verifying reload never silently closes the goal as done",
		!built.states.some((st) => st.goalId === s.goalId && st.gstatus === "done"),
	);
}

// ===========================================================================
// SCENARIO D: TERMINAL snapshots (done / blocked / stopped) are NOT recovered. A finished
// goal stays finished across reload — no zombie goal re-arming a timer or a verifier. We
// verify by reloading a terminal snapshot and confirming NOTHING is re-scheduled or re-judged.
// ===========================================================================
async function terminalSnapshotsAreNotRecovered(goalUrl) {
	for (const term of ["done", "blocked", "stopped"]) {
		const s = snap({ gstatus: term, nextFireAt: null });
		const { built } = await rehydrateFrom(goalUrl, [entry(s)]);
		await flush();
		check(
			`terminal '${term}' snapshot does NOT re-spawn a verifier on reload`,
			built.execCalls.length === 0,
			`execCalls=${built.execCalls.length}`,
		);
		check(
			`terminal '${term}' snapshot does NOT re-inject a wake on reload`,
			built.messages.length === 0,
			`messages=${built.messages.length}`,
		);
		check(
			`terminal '${term}' snapshot persists nothing new (stays finished)`,
			built.states.length === 0,
			`states=${built.states.length}`,
		);
	}
}

// ===========================================================================
// SCENARIO E: last-wins by goalId. The append-only log holds several snapshots of the SAME
// goal; rehydrate keeps the LATEST. If the latest is terminal, the goal is NOT recovered even
// though an earlier 'pursuing' snapshot exists; conversely a terminal-then-live sequence (the
// goal was restarted) recovers the live one.
// ===========================================================================
async function lastWinsByGoalId(goalUrl) {
	const id = "deadbeef";
	// pursuing (early) ... then done (latest): latest is terminal -> NOT recovered.
	{
		const early = snap({
			goalId: id,
			gstatus: "pursuing",
			iteration: 1,
			nextFireAt: Date.now() + 1000,
		});
		const latest = snap({ goalId: id, gstatus: "done", iteration: 5, nextFireAt: null });
		const { built } = await rehydrateFrom(goalUrl, [entry(early), entry(latest)]);
		await flush();
		check(
			"last-wins: pursuing-then-done keeps the DONE (terminal) → goal not re-armed",
			built.execCalls.length === 0 && built.messages.length === 0 && built.states.length === 0,
			`exec=${built.execCalls.length} msg=${built.messages.length} states=${built.states.length}`,
		);
	}
	// done (early) ... then verifying-independent (latest, goal was restarted): recovered + re-judged.
	{
		const early = snap({ goalId: id, gstatus: "done", iteration: 5, nextFireAt: null });
		const latest = snap({
			goalId: id,
			gstatus: "verifying-independent",
			iteration: 6,
			nextFireAt: null,
		});
		const exec = () => ({ code: 0, killed: false, stdout: "VERDICT: PASS", stderr: "" });
		const { built } = await rehydrateFrom(goalUrl, [entry(early), entry(latest)], {
			execImpl: exec,
		});
		await flush(() => lastStatusFor(built.states, id) === "done");
		check(
			"last-wins: done-then-verifying-independent keeps the LATEST → verifier re-runs",
			built.execCalls.length === 1,
			`execCalls=${built.execCalls.length}`,
		);
	}
}

// ===========================================================================
// SCENARIO F: a `fork` session_start does NOT migrate a running goal. A forked session
// inherits the parent's goal-state entries, but the goal must keep running only in the
// parent — rehydrate must be a no-op on fork.
// ===========================================================================
async function forkDoesNotMigrateGoal(goalUrl) {
	const s = snap({ gstatus: "verifying-independent", nextFireAt: null });
	const exec = () => ({ code: 0, killed: false, stdout: "VERDICT: PASS", stderr: "" });
	const { built } = await rehydrateFrom(goalUrl, [entry(s)], { reason: "fork", execImpl: exec });
	await flush();
	check(
		"fork session_start does NOT re-spawn the verifier",
		built.execCalls.length === 0,
		`execCalls=${built.execCalls.length}`,
	);
	check(
		"fork session_start does NOT re-inject a wake",
		built.messages.length === 0,
		`messages=${built.messages.length}`,
	);
	check(
		"fork session_start persists nothing (no migration)",
		built.states.length === 0,
		`states=${built.states.length}`,
	);
}

// ===========================================================================
// SCENARIO G: rehydrate is robust to junk in the log. Non-goal-state entries, entries
// missing a goalId, and a snapshot with an UNKNOWN gstatus are all ignored — they never
// crash rehydrate nor produce a phantom active goal.
// ===========================================================================
async function junkEntriesAreIgnored(goalUrl) {
	const good = snap({ gstatus: "verifying-independent", nextFireAt: null });
	const exec = () => ({ code: 0, killed: false, stdout: "VERDICT: PASS", stderr: "" });
	const entries = [
		{ type: "message", role: "user", content: "hello" }, // not custom
		{ type: "custom", customType: "something-else", data: { goalId: "x" } }, // wrong customType
		{ type: "custom", customType: "goal-state", data: { objective: "no id" } }, // missing goalId
		{ type: "custom", customType: "goal-state", data: snap({ gstatus: "weird-unknown-status" }) }, // unknown status
		entry(good), // the only recoverable one
	];
	const { built } = await rehydrateFrom(goalUrl, entries, { execImpl: exec });
	await flush(() => lastStatusFor(built.states, good.goalId) === "done");
	check(
		"junk/foreign/malformed entries do not crash rehydrate; only the valid goal recovers",
		built.execCalls.length === 1 && lastStatusFor(built.states, good.goalId) === "done",
		`execCalls=${built.execCalls.length} last=${lastStatusFor(built.states, good.goalId)}`,
	);
}

// ===========================================================================
// SCENARIO H: no double-fire. If rehydrate runs again while a goal's timer is already alive
// in this process (e.g. a second session_start), it must NOT re-arm a duplicate. We fire
// session_start twice on the SAME extension instance with a due stale goal and assert the
// catch-up wake happens ONCE, not twice.
// ===========================================================================
async function noDoubleFireOnSecondRehydrate(goalUrl) {
	const goalExtension = await loadDefault(goalUrl);
	const built = makePi();
	goalExtension(built.pi);
	const onStart = built.handlers.get("session_start");
	const s = snap({ gstatus: "stale", iteration: 7, nextFireAt: Date.now() - 1000 });
	const { event, ctx } = makeCtx([entry(s)]);
	// First rehydrate arms the goal (and schedules a due catch-up tick).
	for (const h of onStart) await h(event, ctx);
	// Second rehydrate while the timer/goal is already live: must be a no-op for this goal.
	for (const h of onStart) await h(event, ctx);
	await flush(() => built.messages.length >= 1);
	// Give any erroneous duplicate a chance to also fire before asserting "exactly one".
	await flush(() => false, 20);
	check(
		"second rehydrate does NOT double-arm: exactly one catch-up wake",
		built.messages.length === 1,
		`messages=${built.messages.length}`,
	);
}

// ===========================================================================
// SCENARIO I: NON-INTERACTIVE rehydrate (print / json) is a NO-OP. A /goal can only be
// sustained in tui/rpc — startGoal() already refuses to START one in print/json. The same
// gate must hold on the RELOAD path: rehydrate must not re-arm a catch-up timer NOR spawn the
// independent verifier subprocess in a one-shot/non-interactive session that can never advance
// the goal. wake() being mode-gated only suppresses the prompt RE-INJECTION; it does NOT stop
// rehydrate from (a) launching a heavyweight `pi -p` verifier for a verifying-independent
// snapshot or (b) firing a due catch-up tick that bumps the iteration and persists a fresh
// snapshot. Both are side effects a non-interactive session must not produce; the persisted
// state must be left untouched so a later tui/rpc session recovers it intact.
// ===========================================================================
async function nonInteractiveRehydrateIsNoOp(goalUrl) {
	for (const mode of ["print", "json"]) {
		// (a) The heavyweight path: a verifying-independent snapshot must NOT spawn the verifier.
		{
			const s = snap({ gstatus: "verifying-independent", nextFireAt: null });
			const exec = () => ({ code: 0, killed: false, stdout: "VERDICT: PASS", stderr: "" });
			const { built } = await rehydrateFrom(goalUrl, [entry(s)], { mode, execImpl: exec });
			await flush();
			check(
				`[${mode}] verifying-independent reload does NOT spawn the verifier subprocess`,
				built.execCalls.length === 0,
				`execCalls=${built.execCalls.length}`,
			);
			check(
				`[${mode}] verifying-independent reload persists nothing (state left intact)`,
				built.states.length === 0,
				`states=${built.states.length}`,
			);
			check(
				`[${mode}] verifying-independent reload never closes the goal as done`,
				!built.states.some((st) => st.goalId === s.goalId && st.gstatus === "done"),
				"unexpected done",
			);
		}
		// (b) The timer path: a DUE stale snapshot must NOT fire a catch-up tick (no iteration
		// bump, no persisted snapshot, no wake) — the goal cannot run in this mode at all.
		{
			const s = snap({ gstatus: "stale", iteration: 3, nextFireAt: Date.now() - 1000 });
			const { built } = await rehydrateFrom(goalUrl, [entry(s)], { mode });
			await flush();
			check(
				`[${mode}] stale reload does NOT re-inject a wake`,
				built.messages.length === 0,
				`messages=${built.messages.length}`,
			);
			check(
				`[${mode}] stale reload does NOT bump the iteration / persist a snapshot`,
				built.states.length === 0,
				`states=${built.states.length}`,
			);
		}
	}
}

// ===========================================================================
async function main() {
	const { outDir, url } = await buildGoal();
	try {
		await verifyingIndependentReRunsVerifierAndPasses(url);
		await verifyingIndependentReRunFailDoesNotClose(url);
		await verifyingIndependentReRunFailAtCapBlocks(url);
		await verifyingIndependentReloadIgnoresReentry(url);
		await verifyingIndependentReloadSurvivesAgentEnd(url);
		await staleResumesPursuing(url);
		await verifyingResumesVerifying(url);
		await terminalSnapshotsAreNotRecovered(url);
		await lastWinsByGoalId(url);
		await forkDoesNotMigrateGoal(url);
		await junkEntriesAreIgnored(url);
		await noDoubleFireOnSecondRehydrate(url);
		await nonInteractiveRehydrateIsNoOp(url);
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
	// Recovered goals re-arm with setTimeout timers that keep the event loop open; exit
	// explicitly rather than hang after a green run.
	process.exit(0);
}

main().catch((err) => {
	console.error("INTEGRATION TEST CRASH:", err?.stack ? err.stack : err);
	process.exit(2);
});
