/**
 * Durable behavioral integration test for the COMMAND / TOOL / ENGINE paths of
 * extensions/pandi-goal/index.ts that the sibling goal-rehydrate.test.mjs does NOT exercise.
 *
 * Why this file exists
 * --------------------
 * `npm test` is a TYPECHECK only (`tsc --noEmit`). The /goal engine is a persistent,
 * crash-recoverable scheduler whose live behavior — the iteration cap, the agent_end
 * safety net, the goal_progress tool's branches (no-active-goal, blocked), the independent
 * verifier reentrancy guard, the session_shutdown disposition, and the `/goal stop`
 * subcommand + resolveGoal selection — is invisible to `tsc`. This suite drives the REAL
 * registered command/tool/event handlers against a mocked pi/ctx and pins the OBSERVABLE
 * contract (persisted gstatus, notifications, verifier spawns, re-injected wakes).
 *
 * These are CHARACTERIZATION tests: they assert the source's CURRENT behavior. The source is
 * the source of truth.
 *
 * How it works
 * ------------
 * Self-bootstrapping, same proven pattern as goal-rehydrate.test.mjs: it esbuilds the CURRENT
 * extensions/pandi-goal/index.ts into an OS temp dir, aliasing the two external peer packages
 * (typebox, @earendil-works/pi-coding-agent) to local stubs so it runs from a clean checkout
 * with NO `npm install`. Each scenario gets a FRESH extension instance (loadDefault's
 * cache-busting query) so the module's activeGoals singleton never leaks between scenarios.
 *
 * Run it:
 *   node extensions/pandi-goal/tests/integration/index-coverage.test.mjs
 *
 * Exit 0 = all checks passed; 1 = a behavioral check failed; 2 = harness crashed.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExtension, createChecker, loadDefault, sdkStub } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

const { check, counts } = createChecker();

async function buildGoal() {
	return await buildExtension({
		name: "pi-goal-index-coverage-integration",
		src: path.join(REPO_ROOT, "extensions", "pandi-goal", "index.ts"),
		outName: "goal.mjs",
		stubs: { typebox: true, sdk: (dir) => sdkStub(dir) },
	});
}

// Yield to BOTH the timer phase (setTimeout) and the check phase (setImmediate) so
// fire-and-forget async chains (the independent verifier) and the catch-up tick settle.
async function flush(predicate, tries = 100) {
	for (let i = 0; i < tries; i++) {
		await new Promise((r) => setTimeout(r, 0));
		await new Promise((r) => setImmediate(r));
		if (predicate?.()) return;
	}
}

// Mock pi: capture persisted snapshots, re-injected messages, and verifier subprocesses.
function makePi(execImpl) {
	const tools = new Map();
	const commands = new Map();
	const handlers = new Map();
	const states = [];
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

function entry(snap) {
	return { type: "custom", customType: "goal-state", data: snap };
}

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

function makeEnv(entries = [], opts = {}) {
	const { mode = "tui", reason = "startup", selectImpl } = opts;
	const notifies = [];
	const event = { reason };
	const ctx = {
		mode,
		hasUI: true,
		cwd: REPO_ROOT,
		isIdle: () => true,
		isProjectTrusted: () => false,
		getContextUsage: () => undefined,
		ui: {
			theme: { fg: (_c, s) => s },
			notify: (message, type) => notifies.push({ message, type }),
			setStatus: () => {},
			confirm: async () => true,
			select: async (q, items) => (selectImpl ? selectImpl(q, items) : undefined),
		},
		sessionManager: { getEntries: () => entries },
	};
	return { event, ctx, notifies };
}

async function register(goalUrl, execImpl) {
	const goalExtension = await loadDefault(goalUrl);
	const built = makePi(execImpl);
	goalExtension(built.pi);
	return built;
}

async function fireStart(built, env) {
	for (const h of built.handlers.get("session_start") ?? []) await h(env.event, env.ctx);
}
async function fireAgentEnd(built, env) {
	for (const h of built.handlers.get("agent_end") ?? []) await h({}, env.ctx);
}
async function fireShutdown(built, env) {
	for (const h of built.handlers.get("session_shutdown") ?? []) await h({}, env.ctx);
}
async function runCommand(built, args, env) {
	const cmd = built.commands.get("goal");
	if (!cmd) throw new Error("goal command not registered");
	await cmd.handler(args, env.ctx);
}
async function runProgress(built, params, env) {
	const tool = built.tools.get("goal_progress");
	if (!tool) throw new Error("goal_progress tool not registered");
	return await tool.execute("tc", params, undefined, undefined, env.ctx);
}

function lastSnapFor(states, goalId) {
	for (let i = states.length - 1; i >= 0; i--) if (states[i].goalId === goalId) return states[i];
	return undefined;
}
function lastStatusFor(states, goalId) {
	return lastSnapFor(states, goalId)?.gstatus;
}
function warned(notifies, re) {
	return notifies.some((n) => n.type === "warning" && re.test(n.message));
}

// ===========================================================================
// 1. fireGoal stops when iteration >= maxIterations (cap → stopped + warning).
// Recover a due `stale` snapshot whose iteration already equals maxIterations; the
// catch-up tick fires fireGoal, which must cut it at the cap before doing any work.
// ===========================================================================
async function stopsAtMaxIterations(goalUrl) {
	const built = await register(goalUrl);
	const s = snap({ gstatus: "stale", iteration: 1, maxIterations: 1, nextFireAt: Date.now() - 1000 });
	const env = makeEnv([entry(s)]);
	await fireStart(built, env);
	await flush(() => lastStatusFor(built.states, s.goalId) === "stopped");
	const last = lastSnapFor(built.states, s.goalId);
	check("maxIterations cap → final gstatus stopped", last?.gstatus === "stopped", `last=${last?.gstatus}`);
	check(
		"maxIterations cap → lastReason names the cap",
		!!last && /reached maxIterations \(1\)/.test(last.lastReason || ""),
		`reason=${last?.lastReason}`,
	);
	check("maxIterations cap → a warning notify fired", warned(env.notifies, /maxIterations \(1\)/), "no warning");
	check(
		"maxIterations cap → did NOT re-inject a wake",
		built.messages.length === 0,
		`messages=${built.messages.length}`,
	);
}

// ===========================================================================
// 2. agent_end safety net re-arms a stranded pursuing goal. After startGoal the goal is
// pursuing with no live timer, rearmedThisTurn=false, nextFireAt=null (a turn that ended
// without goal_progress). agent_end must defensively re-arm it.
// ===========================================================================
async function agentEndReArmsStrandedPursuing(goalUrl) {
	const built = await register(goalUrl);
	const env = makeEnv();
	await runCommand(built, "make the build green", env);
	const before = built.states.length;
	await fireAgentEnd(built, env);
	const rearm = built.states.find((st) => st.lastReason === "auto: turn closed without goal_progress");
	check(
		"agent_end re-armed a stranded pursuing goal (auto reason persisted)",
		!!rearm,
		`states=${built.states.length}`,
	);
	check(
		"agent_end re-arm set a future nextFireAt (timer scheduled)",
		!!rearm && typeof rearm.nextFireAt === "number" && rearm.nextFireAt > Date.now(),
		`nextFireAt=${rearm?.nextFireAt}`,
	);
	check(
		"agent_end re-arm persisted exactly one new snapshot",
		built.states.length === before + 1,
		`+${built.states.length - before}`,
	);
}

// agent_end must NOT double-arm: a second agent_end in the same turn (rearmedThisTurn=true
// now) is a no-op.
async function agentEndDoesNotDoubleArm(goalUrl) {
	const built = await register(goalUrl);
	const env = makeEnv();
	await runCommand(built, "make the build green", env);
	await fireAgentEnd(built, env);
	const afterFirst = built.states.length;
	await fireAgentEnd(built, env);
	check(
		"second agent_end in same turn does NOT re-arm again",
		built.states.length === afterFirst,
		`+${built.states.length - afterFirst}`,
	);
}

// ===========================================================================
// 3. goal_progress with no active goal → isError response.
// ===========================================================================
async function goalProgressNoActiveGoal(goalUrl) {
	const built = await register(goalUrl);
	const env = makeEnv();
	const r = await runProgress(built, { status: "continue", assessment: "x", nextStep: "y" }, env);
	check("goal_progress with no active goal → isError true", r?.details?.isError === true, JSON.stringify(r?.details));
	check(
		"goal_progress with no active goal → 'No active goal' text",
		/No active goal/.test(r?.content?.[0]?.text || ""),
		r?.content?.[0]?.text,
	);
	check(
		"goal_progress with no active goal persists nothing",
		built.states.length === 0,
		`states=${built.states.length}`,
	);
}

// ===========================================================================
// 4. beginIndependentVerification reentrancy: a goal STOPPED while the verifier runs must
// stay stopped — the late PASS verdict is discarded (no `done` snapshot appended).
// ===========================================================================
async function verifierStoppedMidFlightDiscardsVerdict(goalUrl) {
	let release;
	const gate = new Promise((r) => {
		release = r;
	});
	const exec = async () => {
		await gate;
		return { code: 0, killed: false, stdout: "VERDICT: PASS", stderr: "" };
	};
	const built = await register(goalUrl, exec);
	const s = snap({ gstatus: "verifying-independent", nextFireAt: null });
	const env = makeEnv([entry(s)]);
	await fireStart(built, env);
	check("verifier launched once (in flight)", built.execCalls.length === 1, `execCalls=${built.execCalls.length}`);
	check(
		"goal parked in verifying-independent before stop",
		lastStatusFor(built.states, s.goalId) === "verifying-independent",
		`last=${lastStatusFor(built.states, s.goalId)}`,
	);
	// Stop the goal while the verifier is gated mid-flight.
	await runCommand(built, `stop ${s.goalId}`, env);
	check(
		"goal is stopped while verifier in flight",
		lastStatusFor(built.states, s.goalId) === "stopped",
		`last=${lastStatusFor(built.states, s.goalId)}`,
	);
	// Release the gated PASS: it must be discarded (goal already stopped).
	release();
	await flush(() => false, 40);
	check(
		"late PASS verdict is discarded (no done snapshot appended after stop)",
		!built.states.some((st) => st.goalId === s.goalId && st.gstatus === "done"),
		"unexpected done",
	);
	check(
		"goal stays stopped after the late verdict",
		lastStatusFor(built.states, s.goalId) === "stopped",
		`last=${lastStatusFor(built.states, s.goalId)}`,
	);
	check("no second verifier was spawned", built.execCalls.length === 1, `execCalls=${built.execCalls.length}`);
}

// ===========================================================================
// 5. goal_progress status==='blocked' → stopGoal(blocked) + warning notify.
// ===========================================================================
async function goalProgressBlocked(goalUrl) {
	const built = await register(goalUrl);
	const env = makeEnv();
	await runCommand(built, "deploy to prod", env);
	const r = await runProgress(
		built,
		{ status: "blocked", assessment: "cannot proceed", blocker: "need prod creds" },
		env,
	);
	check("blocked → tool reports details.status blocked", r?.details?.status === "blocked", JSON.stringify(r?.details));
	const last = lastSnapFor(built.states, r?.details?.goalId);
	check("blocked → final gstatus blocked", last?.gstatus === "blocked", `last=${last?.gstatus}`);
	check(
		"blocked → lastReason carries the blocker text",
		!!last && /need prod creds/.test(last.lastReason || ""),
		`reason=${last?.lastReason}`,
	);
	check("blocked → a warning notify fired", warned(env.notifies, /need prod creds/), "no warning");
}

// ===========================================================================
// 6. rehydrate of a verifying-independent snapshot re-runs the verifier exactly once; a
// second session_start while the goal is already live does NOT re-launch it.
// ===========================================================================
async function rehydrateVerifierOnceNoDoubleFire(goalUrl) {
	let release;
	const gate = new Promise((r) => {
		release = r;
	});
	const exec = async () => {
		await gate;
		return { code: 0, killed: false, stdout: "VERDICT: PASS", stderr: "" };
	};
	const built = await register(goalUrl, exec);
	const s = snap({ gstatus: "verifying-independent", nextFireAt: null });
	const env = makeEnv([entry(s)]);
	await fireStart(built, env);
	check(
		"verifying-independent reload spawns exactly one verifier",
		built.execCalls.length === 1,
		`execCalls=${built.execCalls.length}`,
	);
	// Second session_start while the goal is already live (timer/in-flight): no re-launch.
	await fireStart(built, env);
	check(
		"already-live goal is NOT re-launched on a second session_start",
		built.execCalls.length === 1,
		`execCalls=${built.execCalls.length}`,
	);
	release();
	await flush(() => lastStatusFor(built.states, s.goalId) === "done");
	check(
		"released verifier PASS closes the goal (done)",
		lastStatusFor(built.states, s.goalId) === "done",
		`last=${lastStatusFor(built.states, s.goalId)}`,
	);
}

// ===========================================================================
// 7. session_shutdown disposition: a pursuing goal persists as `stale`; a verifying goal
// persists verbatim as `verifying`.
// ===========================================================================
async function shutdownPursuingBecomesStale(goalUrl) {
	const built = await register(goalUrl);
	const env = makeEnv();
	await runCommand(built, "ship it", env);
	const gid = lastSnapFor(built.states, undefined)?.goalId ?? built.states[0]?.goalId;
	await fireShutdown(built, env);
	check(
		"session_shutdown: pursuing goal persists as stale",
		lastStatusFor(built.states, gid) === "stale",
		`last=${lastStatusFor(built.states, gid)}`,
	);
}

async function shutdownVerifyingStaysVerifying(goalUrl) {
	const built = await register(goalUrl);
	// Recover a verifying snapshot with a FUTURE nextFireAt so no catch-up tick fires; it
	// stays verifying until shutdown persists it verbatim.
	const s = snap({ gstatus: "verifying", nextFireAt: Date.now() + 100000 });
	const env = makeEnv([entry(s)]);
	await fireStart(built, env);
	await fireShutdown(built, env);
	check(
		"session_shutdown: verifying goal persists verbatim as verifying",
		lastStatusFor(built.states, s.goalId) === "verifying",
		`last=${lastStatusFor(built.states, s.goalId)}`,
	);
	check(
		"session_shutdown: verifying goal is not downgraded to stale",
		!built.states.some((st) => st.goalId === s.goalId && st.gstatus === "stale"),
		"unexpected stale",
	);
}

// ===========================================================================
// 8. /goal stop subcommand + resolveGoal: with two active goals, a stubbed ui.select picks
// one; `/goal stop <id>` stops exactly that id.
// ===========================================================================
async function stopSubcommandResolvesGoal(goalUrl) {
	const built = await register(goalUrl);
	const a = snap({ goalId: "aaaa1111", gstatus: "pursuing", nextFireAt: Date.now() + 100000 });
	const b = snap({ goalId: "bbbb2222", gstatus: "pursuing", nextFireAt: Date.now() + 100000 });
	const env = makeEnv([entry(a), entry(b)], {
		selectImpl: (_q, items) => items.find((i) => i.startsWith("aaaa1111")),
	});
	await fireStart(built, env);
	// `/goal stop` with no id → two candidates → ui.select picks aaaa1111.
	await runCommand(built, "stop", env);
	check(
		"`/goal stop` (no id) stops the ui.select-chosen goal",
		lastStatusFor(built.states, "aaaa1111") === "stopped",
		`a=${lastStatusFor(built.states, "aaaa1111")}`,
	);
	check(
		"`/goal stop` (no id) leaves the unchosen goal untouched",
		!built.states.some((st) => st.goalId === "bbbb2222" && st.gstatus === "stopped"),
		"bbbb2222 wrongly stopped",
	);
	// `/goal stop <id>` stops exactly that id.
	await runCommand(built, "stop bbbb2222", env);
	check(
		"`/goal stop <id>` stops exactly that id",
		lastStatusFor(built.states, "bbbb2222") === "stopped",
		`b=${lastStatusFor(built.states, "bbbb2222")}`,
	);
}

// A `/goal stop` with no matching goal warns and persists nothing.
async function stopNoMatchWarns(goalUrl) {
	const built = await register(goalUrl);
	const env = makeEnv();
	await runCommand(built, "stop", env);
	check(
		"`/goal stop` with no active goal warns 'No matching goal'",
		warned(env.notifies, /No matching goal/),
		"no warning",
	);
	check(
		"`/goal stop` with no active goal persists nothing",
		built.states.length === 0,
		`states=${built.states.length}`,
	);
}

// ===========================================================================
// session_shutdown while an INDEPENDENT verifier is mid-flight: the goal is persisted verbatim
// as verifying-independent (so rehydrate re-runs the verifier), and the aborted verifier's late
// verdict must be DISCARDED — it must not finalize the goal (done/blocked) or message the dead
// session. The post-await guard has to notice the controller was aborted by shutdown.
// ===========================================================================
async function shutdownDuringIndependentVerifyDiscardsVerdict(goalUrl) {
	let release;
	const gate = new Promise((r) => {
		release = r;
	});
	const exec = async () => {
		await gate;
		return { code: 0, killed: false, stdout: "VERDICT: PASS", stderr: "" };
	};
	const built = await register(goalUrl, exec);
	const s = snap({ gstatus: "verifying-independent", nextFireAt: null });
	const env = makeEnv([entry(s)]);
	await fireStart(built, env);
	check("verifier launched once (in flight)", built.execCalls.length === 1, `execCalls=${built.execCalls.length}`);
	// Shut down while the verifier is gated mid-flight.
	await fireShutdown(built, env);
	check(
		"shutdown persists the goal as verifying-independent (rehydrate re-runs the verifier)",
		lastStatusFor(built.states, s.goalId) === "verifying-independent",
		`last=${lastStatusFor(built.states, s.goalId)}`,
	);
	const msgsBefore = built.messages.length;
	// Release the gated PASS: it arrives AFTER shutdown and must be discarded.
	release();
	await flush(() => false, 40);
	check(
		"post-shutdown PASS is discarded (no done snapshot appended)",
		!built.states.some((st) => st.goalId === s.goalId && st.gstatus === "done"),
		"unexpected done after shutdown",
	);
	check(
		"goal's final persisted status stays verifying-independent",
		lastStatusFor(built.states, s.goalId) === "verifying-independent",
		`last=${lastStatusFor(built.states, s.goalId)}`,
	);
	check(
		"no user message sent on the dead session after shutdown",
		built.messages.length === msgsBefore,
		`messages delta=${built.messages.length - msgsBefore}`,
	);
}

// ===========================================================================
// A stopped/terminal goal must be removed from the in-memory activeGoals map (mirrors
// pi-loop's stopLoop -> activeLoops.delete). The leak is observable via `/goal status`
// (no id), which lists [...activeGoals.values()]: after a stop it must report "No goals.",
// not keep listing the dead terminal goal forever.
// ===========================================================================
async function stoppedGoalRemovedFromActiveMap(goalUrl) {
	const built = await register(goalUrl);
	const s = snap({ goalId: "cccc3333", gstatus: "pursuing", nextFireAt: Date.now() + 100000 });
	const env = makeEnv([entry(s)]);
	await fireStart(built, env);
	await runCommand(built, `stop ${s.goalId}`, env);
	check(
		"precondition: goal is stopped",
		lastStatusFor(built.states, s.goalId) === "stopped",
		`last=${lastStatusFor(built.states, s.goalId)}`,
	);
	// Isolate the notify emitted by `/goal status` from the stop notify.
	env.notifies.length = 0;
	await runCommand(built, "status", env);
	const last = env.notifies[env.notifies.length - 1];
	check(
		"`/goal status` after stop reports no active goals (terminal goal removed from activeGoals)",
		/No goals\./.test(last?.message ?? ""),
		`last notify=${JSON.stringify(last)}`,
	);
}

// ===========================================================================
async function main() {
	const { outDir, url } = await buildGoal();
	try {
		await stopsAtMaxIterations(url);
		await agentEndReArmsStrandedPursuing(url);
		await agentEndDoesNotDoubleArm(url);
		await goalProgressNoActiveGoal(url);
		await verifierStoppedMidFlightDiscardsVerdict(url);
		await goalProgressBlocked(url);
		await rehydrateVerifierOnceNoDoubleFire(url);
		await shutdownPursuingBecomesStale(url);
		await shutdownVerifyingStaysVerifying(url);
		await stopSubcommandResolvesGoal(url);
		await stopNoMatchWarns(url);
		await stoppedGoalRemovedFromActiveMap(url);
		await shutdownDuringIndependentVerifyDiscardsVerdict(url);
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
	// Recovered/started goals re-arm setTimeout timers that keep the event loop open; exit
	// explicitly rather than hang after a green run.
	process.exit(0);
}

main().catch((err) => {
	console.error("INTEGRATION TEST CRASH:", err?.stack ? err.stack : err);
	process.exit(2);
});
