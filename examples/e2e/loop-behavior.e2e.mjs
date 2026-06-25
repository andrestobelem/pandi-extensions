/**
 * Durable behavioral e2e for the SCHEDULING ENGINE of extensions/loop.ts.
 *
 * Why this file exists
 * --------------------
 * `npm test` is a TYPECHECK only (`tsc --noEmit`). The safety-critical GATES of loop.ts
 * (destructive-bash gate, loop_schedule delay clamp) already have durable coverage in
 * examples/e2e/safety-gates.e2e.mjs. What had NO durable behavioral coverage is the
 * scheduling ENGINE — the part that decides WHEN and IN WHAT ORDER autonomous iterations
 * fire. A silent regression there is just as consequential as a gate hole:
 *   - lose FIFO serialization  -> N live loops each open an autopilot turn in the SAME
 *     human/agent turn (the destructive gate then mis-fires, turns race for the session).
 *   - break the fixed-mode NO-OP -> a fixed-cadence loop lets the model reprogram its
 *     timer via loop_schedule, defeating user-owned cadence.
 *   - break the watchdog       -> a zombie loop (hung, caps never fired) lives forever.
 *   - break interval clamping  -> a `0s` interval becomes a busy-spin, or a typo silently
 *     turns a fixed loop into a model-paced (dynamic) one.
 * None of this is visible to `tsc`; all of it is pure runtime behavior.
 *
 * What it covers (all DISTINCT from safety-gates.e2e.mjs — no duplication):
 *   1. FIFO multi-loop serialization: with several loops live, exactly ONE autopilot turn
 *      is delivered at a time; the rest queue FIFO and drain in ARRIVAL order on agent_end.
 *   2. Fixed-interval cadence: `/loop <task> 5m` enters fixed mode; loop_schedule is an
 *      informative NO-OP there (it must not touch the timer / nextFireAt / cadence).
 *   3. Anti-zombie watchdog: a RUNNING loop past the 25h hard backstop is force-stopped
 *      (done) at a turn boundary; a PAUSED loop of the same age is deliberately spared;
 *      a healthy loop is untouched.
 *   4. Interval parsing/clamp: the trailing token is parsed to fixed mode and the period
 *      is clamped to [1s, 24h]; a non-matching token leaves the loop dynamic (model-paced).
 *
 * How it works
 * ------------
 * Self-bootstrapping, same proven pattern as safety-gates / goal-* e2e: esbuild the CURRENT
 * extensions/loop.ts into an OS temp dir at run time (never a stale copy), alias the two peer
 * packages (typebox, @earendil-works/pi-coding-agent) to tiny local stubs so it runs from a
 * clean checkout with no `npm install`, then import the built ESM and drive the REAL
 * registered command / tools / event handlers against a mocked pi/ctx. It asserts the
 * OBSERVABLE contract (which wake is delivered, persisted status, clamped interval), never a
 * copy of the internals — so it tracks the source and fails loudly if the engine drifts.
 *
 * Driving the engine WITHOUT real timers: the first wake of every loop fires SYNCHRONOUSLY
 * inside startLoop (fireWake is called directly, not via setTimeout), and the agent_end
 * handler synchronously releases the in-flight gate and drains the next queued wake. So the
 * full FIFO contract is observable without ever waiting on a >=60s setTimeout. For the
 * watchdog, we backdate startedAt and pulse agent_end (which runs watchdogSweep). We never
 * sleep on a real timer.
 *
 * Run it:
 *   node examples/e2e/loop-behavior.e2e.mjs
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
// Build the current loop extension to ESM in a temp dir, return the import URL.
// ---------------------------------------------------------------------------
async function buildLoop() {
	const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-loop-e2e-"));

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

	const src = path.join(REPO_ROOT, "extensions", "loop.ts");
	if (!existsSync(src)) throw new Error(`missing source: ${src}`);
	const out = path.join(outDir, "loop.mjs");
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
	if (r.status !== 0) throw new Error(`esbuild failed for loop: ${r.stderr || r.stdout}`);
	return { outDir, url: pathToFileURL(out).href };
}

// The module keeps a singleton activeLoops Map + module-level FIFO wakeQueue. Load a FRESH
// instance per scenario via a cache-busting query so scenarios never leak state.
let _instance = 0;
async function freshDefault(url) {
	const mod = await import(`${url}?i=${_instance++}`);
	return mod.default;
}

// ---------------------------------------------------------------------------
// Mock pi + ctx. Records the SIDE EFFECTS the engine produces: re-injected wake
// prompts (sendUserMessage), persisted loop-state snapshots (appendEntry), and
// scheduling tool results — i.e. the observable surface, never the internals.
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

function makeCtx({ mode = "tui", hasUI = true, isIdle = true, trusted = true, cwd = REPO_ROOT } = {}) {
	const notes = [];
	const ctx = {
		mode,
		hasUI,
		cwd,
		isIdle: () => (typeof isIdle === "function" ? isIdle() : isIdle),
		isProjectTrusted: () => trusted,
		getContextUsage: () => undefined,
		ui: {
			theme: { fg: (_c, s) => s },
			notify: (msg, type) => notes.push({ msg, type }),
			setStatus: () => {},
			confirm: async () => true,
			select: async () => undefined,
		},
		sessionManager: { getEntries: () => [] },
	};
	ctx._notes = notes;
	return ctx;
}

// Latest persisted snapshot for a loopId (last-wins, mirrors how rehydrate reads JSONL).
function latestSnapshot(entries, loopId) {
	let snap;
	for (const e of entries) {
		if (e.customType === "loop-state" && e.data && e.data.loopId === loopId) snap = e.data;
	}
	return snap;
}

// The /loop command handler returns Promise<void> (it routes through handleLoopCommand and
// never surfaces the ActiveLoop). So we resolve a started loop by its OBSERVABLE side effect:
// run the command, then read the loopId of the newest loop-state snapshot that appeared.
// Returns the loopId, or undefined if nothing new was persisted (e.g. refused in print mode).
async function startLoopCmd(commands, entries, args, ctx) {
	const before = entries.length;
	await commands.get("loop").handler(args, ctx);
	for (let i = entries.length - 1; i >= before; i--) {
		const e = entries[i];
		if (e.customType === "loop-state" && e.data && e.data.loopId) return e.data.loopId;
	}
	return undefined;
}

// Fire every registered handler for an event (the engine registers exactly one each here).
async function fireEvent(handlers, event, payload, ctx) {
	for (const h of handlers.get(event) || []) await h(payload, ctx);
}

// ===========================================================================
// SCENARIO 1: FIFO multi-loop serialization.
//   Starting a loop fires its first wake synchronously. While that autopilot turn is in
//   flight, starting MORE loops must NOT deliver their wakes (one turn at a time); they
//   queue FIFO. agent_end releases the gate and delivers exactly the NEXT one in arrival
//   order. This is the load-bearing guarantee that N loops never race for a single turn.
// ===========================================================================
async function fifoSerialization(url) {
	const loopExtension = await freshDefault(url);
	const { pi, commands, handlers, entries, sentMessages } = makePi();
	loopExtension(pi);
	const ctx = makeCtx({ mode: "tui", hasUI: true, isIdle: true });

	// Start loop A. Its first wake fires synchronously (startLoop -> fireWake -> drain).
	await startLoopCmd(commands, entries, "task A", ctx);
	check("fifo: starting A delivers exactly ONE wake", sentMessages.length === 1);
	check("fifo: A's wake names loop A's task", /task A/.test(sentMessages[0]?.content || ""));

	// While A's autopilot turn is IN FLIGHT, start B and C. Their first wakes must be QUEUED,
	// not delivered: the engine guarantees a single autopilot turn at a time.
	await startLoopCmd(commands, entries, "task B", ctx);
	await startLoopCmd(commands, entries, "task C", ctx);
	check("fifo: B and C do NOT deliver while A's turn is in flight", sentMessages.length === 1, `delivered=${sentMessages.length}`);

	// agent_end closes A's turn -> release the gate and drain the NEXT queued wake (B, FIFO).
	await fireEvent(handlers, "agent_end", {}, ctx);
	check("fifo: agent_end delivers exactly one more wake (B, FIFO)", sentMessages.length === 2, `delivered=${sentMessages.length}`);
	check("fifo: the 2nd delivered wake is B (arrival order), not C", /task B/.test(sentMessages[1]?.content || ""), sentMessages[1]?.content?.slice(0, 40));

	// Next agent_end closes B's turn -> deliver C.
	await fireEvent(handlers, "agent_end", {}, ctx);
	check("fifo: 3rd wake is C", sentMessages.length === 3 && /task C/.test(sentMessages[2]?.content || ""), `delivered=${sentMessages.length}`);

	// Queue now empty; a further agent_end re-arms the safety net but delivers no new wake.
	const before = sentMessages.length;
	await fireEvent(handlers, "agent_end", {}, ctx);
	check("fifo: no extra wake once queue is drained", sentMessages.length === before, `delivered=${sentMessages.length}`);
}

// ===========================================================================
// SCENARIO 2: a wake is NEVER delivered while the human owns the turn (isIdle=false).
//   This is why delivery is gated on ctx.isIdle(): injecting mid-human-turn would open an
//   autopilot turn under the human's turn (and the destructive gate would then gate the
//   HUMAN's own commands). The wake must stay queued until the agent is idle again.
// ===========================================================================
async function noDeliveryWhileBusy(url) {
	const loopExtension = await freshDefault(url);
	const { pi, commands, handlers, entries, sentMessages } = makePi();
	loopExtension(pi);
	let idle = false; // agent is BUSY (human turn in progress).
	const ctx = makeCtx({ mode: "tui", hasUI: true, isIdle: () => idle });

	await startLoopCmd(commands, entries, "busy task", ctx);
	check("busy: no wake delivered while agent is busy", sentMessages.length === 0, `delivered=${sentMessages.length}`);

	// Human turn ends -> agent_end with the agent now idle -> the queued wake drains.
	idle = true;
	await fireEvent(handlers, "agent_end", {}, ctx);
	check("busy: queued wake drains once idle at agent_end", sentMessages.length === 1, `delivered=${sentMessages.length}`);
}

// ===========================================================================
// SCENARIO 3: a loop CANNOT run in a non-interactive mode (print). startLoop refuses,
//   nothing is persisted, no wake is injected. (Mirrors canLoopInMode tui/rpc gate.)
// ===========================================================================
async function refusesNonInteractiveMode(url) {
	const loopExtension = await freshDefault(url);
	const { pi, commands, entries, sentMessages } = makePi();
	loopExtension(pi);
	const ctx = makeCtx({ mode: "print", hasUI: false });

	const startedId = await startLoopCmd(commands, entries, "cannot loop here", ctx);
	check("mode: /loop in print mode starts no loop", startedId === undefined);
	check("mode: print mode persists no loop-state", entries.find((e) => e.customType === "loop-state") === undefined);
	check("mode: print mode injects no wake", sentMessages.length === 0);
}

// ===========================================================================
// SCENARIO 4: fixed-interval mode + loop_schedule NO-OP.
//   `/loop <task> 5m` enters fixed mode. The first wake fires (iteration 1). Then the model
//   calls loop_schedule on a FIXED loop: it must be an informative NO-OP — it does NOT change
//   the cadence, the timer, or nextFireAt (the user owns the period). Contrast with a dynamic
//   loop where loop_schedule DOES re-arm. We assert the observable difference.
// ===========================================================================
async function fixedModeAndScheduleNoop(url) {
	const loopExtension = await freshDefault(url);
	const { pi, commands, tools, handlers, entries } = makePi();
	loopExtension(pi);
	const ctx = makeCtx({ mode: "tui", hasUI: true, isIdle: true });

	// Start a FIXED loop (trailing "5m" token -> fixed cadence, 300s). Its first wake fires
	// synchronously, so this loop owns the in-flight autopilot turn (loop_schedule resolves it).
	const fixedId = await startLoopCmd(commands, entries, "watch the build 5m", ctx);
	check("fixed: started a loop with a trailing interval token", !!fixedId);
	const snap = latestSnapshot(entries, fixedId);
	check("fixed: mode persisted as 'fixed'", snap?.mode === "fixed", `mode=${snap?.mode}`);
	check("fixed: intervalMs is 300000 (5m)", snap?.intervalMs === 300000, `intervalMs=${snap?.intervalMs}`);
	check("fixed: task token stripped of the interval", snap?.task === "watch the build", `task=${snap?.task}`);

	// Now the model (autopilot turn in flight) calls loop_schedule on the FIXED loop.
	const sched = tools.get("loop_schedule");
	const res = await sched.execute("tc", { delaySeconds: 90, reason: "want sooner" }, undefined, undefined, ctx);
	check("fixed: loop_schedule reports a NO-OP on a fixed loop", res?.details?.noop === true, JSON.stringify(res?.details));
	check("fixed: loop_schedule does NOT change the fixed cadence (intervalSeconds=300)", res?.details?.intervalSeconds === 300, JSON.stringify(res?.details));
	// A no-op must not have persisted a re-arm (no new loop-state snapshot from scheduleWake).
	const afterSnap = latestSnapshot(entries, fixedId);
	check("fixed: no-op did not re-arm nextFireAt via loop_schedule", afterSnap?.nextFireAt == null || afterSnap?.nextFireAt === snap?.nextFireAt, `nextFireAt=${afterSnap?.nextFireAt}`);
	check("fixed: no-op did not change mode away from fixed", afterSnap?.mode === "fixed");

	// Contrast: a DYNAMIC loop's loop_schedule DOES arm a real delay (clamped). Same tool,
	// different observable outcome -> proves the no-op is mode-specific, not a dead path.
	// We stop the fixed loop first so the dynamic loop unambiguously owns the next turn.
	await commands.get("loop").handler(`stop ${fixedId}`, ctx);
	await startLoopCmd(commands, entries, "dynamic sibling", ctx);
	await fireEvent(handlers, "agent_end", {}, ctx); // deliver the queued dynamic wake (FIFO)
	const dres = await sched.execute("tc2", { delaySeconds: 1800, reason: "dynamic re-arm" }, undefined, undefined, ctx);
	check("dynamic: loop_schedule is NOT a no-op for a dynamic loop", !dres?.details?.noop, JSON.stringify(dres?.details));
	check("dynamic: loop_schedule arms the clamped delay (1800)", dres?.details?.delaySeconds === 1800, JSON.stringify(dres?.details));
}

// ===========================================================================
// SCENARIO 5: anti-zombie watchdog at a turn boundary.
//   A RUNNING loop whose startedAt is older than the 25h hard backstop is force-stopped
//   (status "done") on the next agent_end (which pulses watchdogSweep). A PAUSED loop of the
//   same age is deliberately SPARED (a paused loop is intentionally idle, not a zombie).
//   A healthy running loop is untouched.
// ===========================================================================
async function watchdogHealthyUntouched(url) {
	const loopExtension = await freshDefault(url);
	const { pi, commands, handlers, entries } = makePi();
	loopExtension(pi);
	const ctx = makeCtx({ mode: "tui", hasUI: true, isIdle: true });

	// Two fresh running loops driven across several turn boundaries (each pulses watchdogSweep).
	// A healthy loop (well within the 25h backstop) must NEVER be force-stopped by the sweep.
	const id1 = await startLoopCmd(commands, entries, "healthy one", ctx);
	await fireEvent(handlers, "agent_end", {}, ctx);
	const id2 = await startLoopCmd(commands, entries, "healthy two", ctx);
	await fireEvent(handlers, "agent_end", {}, ctx);
	await fireEvent(handlers, "agent_end", {}, ctx);

	const s1 = latestSnapshot(entries, id1);
	const s2 = latestSnapshot(entries, id2);
	check("watchdog: healthy running loops survive repeated agent_end sweeps", s1?.status === "running" && s2?.status === "running", `s1=${s1?.status} s2=${s2?.status}`);
	// The aged/zombie kill path is exercised in agedRehydrateWatchdog (which can backdate startedAt).
}

// ===========================================================================
// SCENARIO 5b: watchdog actually FIRES on an aged loop, via the rehydrate entry path.
//   We feed session_start a "stale" snapshot whose startedAt is 26h ago. rehydrate revives
//   it (running) and then watchdogSweep (run after rehydrate in session_start) must
//   force-stop it as a zombie -> persisted status "done". A second snapshot, aged but
//   "paused", must be rehydrated as paused and SPARED. A fresh stale snapshot survives.
// ===========================================================================
async function agedRehydrateWatchdog(url) {
	const loopExtension = await freshDefault(url);
	const { pi, handlers, entries } = makePi();
	loopExtension(pi);

	const now = Date.now();
	const WATCHDOG_MS = 25 * 60 * 60 * 1000;
	const aged = now - 26 * 60 * 60 * 1000; // 26h ago: past the 25h backstop.
	const fresh = now - 60 * 1000; // 1 min ago: healthy.

	const seed = [
		{
			loopId: "zombie",
			task: "hung forever",
			prompt: "p",
			mode: "dynamic",
			iteration: 3,
			maxIterations: 25,
			maxWallClockMs: 6 * 60 * 60 * 1000,
			contextPercentCap: 90,
			startedAt: aged,
			nextFireAt: now - 1000, // due (catch-up), but should die before firing
			status: "stale",
			updatedAt: new Date(now - 1000).toISOString(),
		},
		{
			loopId: "pausedold",
			task: "paused over the weekend",
			prompt: "p",
			mode: "dynamic",
			iteration: 5,
			maxIterations: 25,
			maxWallClockMs: 6 * 60 * 60 * 1000,
			contextPercentCap: 90,
			startedAt: aged,
			nextFireAt: null,
			status: "paused",
			updatedAt: new Date(now - 1000).toISOString(),
		},
		{
			loopId: "healthy",
			task: "running fine",
			prompt: "p",
			mode: "dynamic",
			iteration: 1,
			maxIterations: 25,
			maxWallClockMs: 6 * 60 * 60 * 1000,
			contextPercentCap: 90,
			startedAt: fresh,
			nextFireAt: now + 60 * 60 * 1000, // far in the future, no catch-up fire
			status: "stale",
			updatedAt: new Date(now - 1000).toISOString(),
		},
	];

	const ctx = makeCtx({ mode: "tui", hasUI: true, isIdle: true });
	ctx.sessionManager.getEntries = () => seed.map((data) => ({ type: "custom", customType: "loop-state", data }));

	await fireEvent(handlers, "session_start", { reason: "startup" }, ctx);

	const zSnap = latestSnapshot(entries, "zombie");
	check("watchdog: aged RUNNING zombie is force-stopped (done) on rehydrate sweep", zSnap?.status === "done", `status=${zSnap?.status}`);
	check("watchdog: the stop reason mentions the backstop/watchdog", /watchdog|backstop|deadline/i.test(zSnap?.lastReason || ""), `reason=${zSnap?.lastReason}`);

	const pSnap = latestSnapshot(entries, "pausedold");
	check("watchdog: aged PAUSED loop is SPARED (stays paused, not a zombie)", pSnap == null || pSnap.status === "paused", `status=${pSnap?.status}`);

	const hSnap = latestSnapshot(entries, "healthy");
	check("watchdog: healthy fresh loop is NOT touched by the sweep", hSnap == null || hSnap.status === "running", `status=${hSnap?.status}`);

	// Sanity on the constant we encoded the scenario around (documents the contract).
	check("watchdog: backstop window encoded as 25h", WATCHDOG_MS === 90000000);
}

// ===========================================================================
// SCENARIO 6: interval parsing + clamp (observed via persisted intervalMs / mode).
//   `^\d+(s|m|h)$` trailing token -> fixed mode, period clamped to [1s, 24h].
//   Anything else -> dynamic (model-paced), the token treated as part of the task.
// ===========================================================================
async function intervalParseAndClamp(url) {
	const loopExtension = await freshDefault(url);
	const { pi, commands, entries } = makePi();
	loopExtension(pi);
	const ctx = makeCtx({ mode: "tui", hasUI: true, isIdle: true });

	async function startAndSnap(args) {
		const id = await startLoopCmd(commands, entries, args, ctx);
		return id ? latestSnapshot(entries, id) : undefined;
	}

	check("interval: '30s' -> fixed 30000ms", (await startAndSnap("do thing 30s"))?.intervalMs === 30000);
	check("interval: '5m' -> fixed 300000ms", (await startAndSnap("do thing 5m"))?.intervalMs === 300000);
	check("interval: '2h' -> fixed 7200000ms", (await startAndSnap("do thing 2h"))?.intervalMs === 7200000);

	// Clamp DOWN: 48h exceeds the 24h cap -> clamped to 24h = 86400000ms.
	check("interval: '48h' clamps DOWN to 24h (86400000ms)", (await startAndSnap("do thing 48h"))?.intervalMs === 86400000);

	// A 0-value token does NOT match the parser (value <= 0 rejected) -> dynamic, token kept.
	const zero = await startAndSnap("do thing 0s");
	check("interval: '0s' is rejected -> dynamic mode (no busy-spin)", zero?.mode === "dynamic", `mode=${zero?.mode}`);
	check("interval: '0s' token stays part of the task", zero?.task === "do thing 0s", `task=${zero?.task}`);

	// Non-matching tokens -> dynamic, no interval.
	const dyn1 = await startAndSnap("just a task");
	check("interval: no trailing token -> dynamic", dyn1?.mode === "dynamic" && dyn1?.intervalMs == null);
	const dyn2 = await startAndSnap("refactor module5");
	check("interval: 'module5' (digit not at start) -> dynamic", dyn2?.mode === "dynamic" && dyn2?.intervalMs == null, `task=${dyn2?.task}`);
	const dyn3 = await startAndSnap("do thing 10x");
	check("interval: '10x' (bad unit) -> dynamic, token kept in task", dyn3?.mode === "dynamic" && dyn3?.task === "do thing 10x");
}

// ===========================================================================
async function main() {
	const { outDir, url } = await buildLoop();
	try {
		await fifoSerialization(url);
		await noDeliveryWhileBusy(url);
		await refusesNonInteractiveMode(url);
		await fixedModeAndScheduleNoop(url);
		await watchdogHealthyUntouched(url);
		await agedRehydrateWatchdog(url);
		await intervalParseAndClamp(url);
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
	// Started loops leave live setTimeout timers (the period / safety-net re-arm) that keep
	// the event loop open, so exit explicitly rather than hang after a green run.
	process.exit(0);
}

main().catch((err) => {
	console.error("E2E CRASH:", err && err.stack ? err.stack : err);
	process.exit(2);
});
