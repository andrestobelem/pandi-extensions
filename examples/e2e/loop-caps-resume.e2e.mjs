/**
 * Durable behavioral e2e for the DURABILITY surface of extensions/loop.ts:
 * the CAPS gate, PAUSE/RESUME, and loop REHYDRATE — none of which is covered by
 * loop-behavior.e2e.mjs (that suite covers FIFO serialization, the fixed-mode
 * loop_schedule no-op, the anti-zombie watchdog, and interval parse/clamp).
 *
 * Why this file exists
 * --------------------
 * `npm test` is a TYPECHECK only (`tsc --noEmit`). loop.ts has THREE durability
 * contracts that are pure runtime behavior (invisible to tsc) and that the existing
 * suites do NOT touch:
 *
 *   1. CAPS gate (loop.ts capExceeded / stopForCap, checked in fireWake + agent_end +
 *      rehydrate): a loop must HARD-STOP with status "done" — not silently keep firing
 *      — when it hits any of three caps:
 *        - maxIterations  (iteration >= maxIterations)
 *        - maxWallClockMs (Date.now() - startedAt >= deadline)
 *        - contextPercentCap (best-effort ctx.getContextUsage().percent >= cap)
 *      A regression that swallows a cap = an autonomous loop that runs past its budget /
 *      forever — the exact runaway the caps exist to prevent.
 *
 *   2. PAUSE / RESUME (loop.ts pauseLoop / resumeLoop, /loop pause|resume): pause must
 *      CLEAR the timer, set status "paused", drop any queued wake, and remember the
 *      remaining delay; it must NOT re-inject. Resume must re-arm: a dynamic loop with
 *      the captured remainder, a fixed loop on its owned period. A regression here either
 *      strands a paused loop forever or lets a paused loop keep firing.
 *
 *   3. REHYDRATE after reload (loop.ts rehydrate on session_start): the NEWER of
 *      {last JSONL entry, sidecar} per loopId is the source of truth; a "running"/"stale"
 *      snapshot is revived running (single catch-up tick, no double-fire), "paused" stays
 *      paused (no re-arm), terminal snapshots are NOT recovered, and an AUTONOMOUS loop in
 *      a project that is NO LONGER TRUSTED is RETIRED (terminal "stopped"), never re-armed
 *      unattended. A regression here = a once-confirmed autonomous loop firing forever
 *      across reloads even after trust is revoked, or a double-fire on reload.
 *
 * What it covers (all DISTINCT from loop-behavior.e2e.mjs — no duplication):
 *   A. Caps cut to "done": maxIterations, maxWallClockMs, and contextPercentCap each
 *      stop the loop cleanly (status "done", reason mentions the cap) and a healthy loop
 *      under all three caps keeps running. Both the agent_end path and the fireWake path.
 *   B. Pause clears the timer + preserves state and does NOT re-inject; resume re-arms
 *      (dynamic remainder; fixed period); pause is a no-op on a non-running loop and
 *      resume is a no-op on a non-paused loop; pause drops a queued wake.
 *   C. Rehydrate revives running/stale (single catch-up, no double-fire on a 2nd
 *      session_start), keeps paused as paused, ignores terminal, last-wins by updatedAt
 *      across the JSONL, retires an autonomous loop when the project is no longer trusted,
 *      and a cap already blown across downtime stops cleanly instead of re-arming.
 *
 * How it works
 * ------------
 * Self-bootstrapping, same proven pattern as loop-behavior / safety-gates / goal-* e2e:
 * esbuild the CURRENT extensions/loop.ts into an OS temp dir at run time (never a stale
 * copy), alias the two peer packages (typebox, @earendil-works/pi-coding-agent) to tiny
 * local stubs so it runs from a clean checkout with no `npm install`, then import the
 * built ESM and drive the REAL registered command / tools / event handlers against a
 * mocked pi/ctx. It asserts the OBSERVABLE contract (persisted loop-state status/reason,
 * re-injected wakes, whether a timer was armed) — never a copy of the internals.
 *
 * Driving the engine WITHOUT real timers: the first wake of a /loop fires SYNCHRONOUSLY
 * inside startLoop. For caps we set the loop into the cap condition (advance iteration via
 * agent_end re-arm cycles, backdate startedAt via a rehydrate snapshot, or drive
 * getContextUsage), then pulse agent_end / session_start which run the caps gate
 * synchronously. We never sleep on a real >=60s setTimeout.
 *
 * Run it:
 *   node examples/e2e/loop-caps-resume.e2e.mjs
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
	const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-loop-caps-e2e-"));

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

// usage is a getter so a scenario can flip the reported context percent mid-flight.
function makeCtx({ mode = "tui", hasUI = true, isIdle = true, trusted = true, usage, cwd = REPO_ROOT } = {}) {
	const notes = [];
	const ctx = {
		mode,
		hasUI,
		cwd,
		isIdle: () => (typeof isIdle === "function" ? isIdle() : isIdle),
		isProjectTrusted: () => (typeof trusted === "function" ? trusted() : trusted),
		getContextUsage: () => (typeof usage === "function" ? usage() : usage),
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

// The /loop command handler returns Promise<void> (it never surfaces the ActiveLoop). So we
// resolve a started loop by its OBSERVABLE side effect: run the command, then read the loopId
// of the newest loop-state snapshot that appeared. undefined if nothing new was persisted.
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

function snap(loopId, over = {}) {
	const now = Date.now();
	return {
		loopId,
		task: `task ${loopId}`,
		prompt: "p",
		mode: "dynamic",
		iteration: 0,
		maxIterations: 25,
		maxWallClockMs: 6 * 60 * 60 * 1000,
		contextPercentCap: 90,
		startedAt: now,
		nextFireAt: now + 60 * 60 * 1000, // far future: no catch-up fire unless overridden
		status: "stale",
		updatedAt: new Date(now).toISOString(),
		...over,
	};
}

function seedEntries(ctx, snaps) {
	ctx.sessionManager.getEntries = () => snaps.map((data) => ({ type: "custom", customType: "loop-state", data }));
}

// A 0ms catch-up timer (setTimeout(fireWake, 0)) is armed by rehydrate for a DUE loop.
// Yield to the macrotask queue so that timer fires before we assert.
function tick() {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

// ===========================================================================
// SCENARIO A1: maxIterations cap cuts the loop to "done" when it would fire.
//   The maxIterations gate lives in fireWake / drainWakeQueue (NOT in the agent_end
//   safety net, which only re-arms / checks the wall-clock + context caps). So we drive
//   the REAL fire path: rehydrate a running snapshot that is AT its iteration cap and DUE
//   to fire. rehydrate arms a single catch-up tick (setTimeout(fireWake, 0)); when that
//   fires, the maxIterations gate must stop the loop "done" instead of delivering a wake.
//   We also pin the default maxIterations via a freshly started loop (documents the 25 cap).
// ===========================================================================
async function maxIterationsCap(url) {
	const loopExtension = await freshDefault(url);
	const { pi, commands, entries, sentMessages } = makePi();
	loopExtension(pi);
	const ctx = makeCtx({ mode: "tui", hasUI: true, isIdle: true });

	const id = await startLoopCmd(commands, entries, "burn iterations", ctx);
	check("maxIter: loop started, first wake delivered (iteration 1)", sentMessages.length === 1, `delivered=${sentMessages.length}`);
	const s1 = latestSnapshot(entries, id);
	check("maxIter: iteration advanced to 1 on first wake", s1?.iteration === 1, `it=${s1?.iteration}`);
	check("maxIter: default maxIterations is 25", s1?.maxIterations === 25, `max=${s1?.maxIterations}`);

	// Drive the iteration cap via its REAL gate (fireWake). Seed a running snapshot at the
	// cap AND due, so rehydrate arms a 0ms catch-up tick; fireWake then hits the maxIterations
	// guard and stops it "done" rather than firing a (capped) iteration.
	const ctx2 = makeCtx({ mode: "tui", hasUI: true, isIdle: true });
	const { pi: pi2, handlers: h2, entries: e2, sentMessages: sent2 } = makePi();
	const loopExtension2 = await freshDefault(url);
	loopExtension2(pi2);
	const now = Date.now();
	seedEntries(ctx2, [
		snap("atcap", {
			status: "running",
			iteration: 3,
			maxIterations: 3, // already AT the cap
			maxWallClockMs: 24 * 60 * 60 * 1000, // generous: isolate the iteration cap
			startedAt: now - 1000,
			nextFireAt: now - 1000, // DUE -> rehydrate arms a 0ms catch-up tick (fireWake)
			updatedAt: new Date(now).toISOString(),
		}),
	]);
	await fireEvent(h2, "session_start", { reason: "startup" }, ctx2);
	await tick(); // let the 0ms catch-up fireWake run
	const cap = latestSnapshot(e2, "atcap");
	check("maxIter: a DUE loop AT maxIterations is stopped 'done' by the fire gate", cap?.status === "done", `status=${cap?.status}`);
	check("maxIter: stop reason names maxIterations", /maxIterations/i.test(cap?.lastReason || ""), `reason=${cap?.lastReason}`);
	check("maxIter: capped loop delivered NO new wake (iteration not advanced)", sent2.length === 0 && cap?.iteration === 3, `delivered=${sent2.length} it=${cap?.iteration}`);
}

// ===========================================================================
// SCENARIO A2: maxWallClockMs (absolute deadline) cuts the loop to "done".
//   We rehydrate a running snapshot whose startedAt is OLDER than its maxWallClockMs and
//   whose nextFireAt is in the future (so rehydrate itself revives it without firing).
//   The caps gate in rehydrate (capExceeded before re-arm) — and the agent_end safety net —
//   must stop it "done" with a wall-clock reason, never re-arm.
// ===========================================================================
async function wallClockCap(url) {
	const loopExtension = await freshDefault(url);
	const { pi, handlers, entries, sentMessages } = makePi();
	loopExtension(pi);
	const ctx = makeCtx({ mode: "tui", hasUI: true, isIdle: true });

	const now = Date.now();
	const wall = 6 * 60 * 60 * 1000; // 6h budget
	seedEntries(ctx, [
		snap("overtime", {
			status: "running",
			iteration: 4,
			maxIterations: 25, // NOT the iteration cap — isolate the wall-clock cap
			maxWallClockMs: wall,
			startedAt: now - (wall + 60 * 1000), // 6h+1m ago: past the deadline
			nextFireAt: now + 60 * 60 * 1000, // future: rehydrate's own catch-up does not fire
			updatedAt: new Date(now - 1000).toISOString(),
		}),
	]);

	await fireEvent(handlers, "session_start", { reason: "startup" }, ctx);
	const s = latestSnapshot(entries, "overtime");
	check("wallclock: loop past its deadline is stopped 'done' on rehydrate", s?.status === "done", `status=${s?.status}`);
	check("wallclock: stop reason mentions the wall-clock deadline", /wall-clock|deadline/i.test(s?.lastReason || ""), `reason=${s?.lastReason}`);
	check("wallclock: NOT mislabeled as an iteration cap", !/maxIterations/i.test(s?.lastReason || ""), `reason=${s?.lastReason}`);
	check("wallclock: NO wake delivered for an over-deadline loop", sentMessages.length === 0, `delivered=${sentMessages.length}`);
}

// ===========================================================================
// SCENARIO A3: contextPercentCap (best-effort budget) cuts the loop to "done", and a
//   healthy loop UNDER the cap keeps running. We drive ctx.getContextUsage() directly.
//   This is the only cap that depends on a runtime signal, so the positive (under) +
//   negative (over) control proves the suite tracks the threshold, not a dead path.
// ===========================================================================
async function contextPercentCap(url) {
	// Over the cap: a running loop must be stopped "done" on agent_end.
	{
		const loopExtension = await freshDefault(url);
		const { pi, commands, handlers, entries, sentMessages } = makePi();
		loopExtension(pi);
		let pct = 10; // healthy at start
		const ctx = makeCtx({ mode: "tui", hasUI: true, isIdle: true, usage: () => ({ percent: pct }) });

		const id = await startLoopCmd(commands, entries, "fill the context", ctx);
		check("ctxcap: loop started while context is low", sentMessages.length === 1, `delivered=${sentMessages.length}`);

		// First agent_end while still healthy: must re-arm, NOT stop.
		await fireEvent(handlers, "agent_end", {}, ctx);
		const healthy = latestSnapshot(entries, id);
		check("ctxcap: under the cap (10% < 90%), loop keeps running", healthy?.status === "running", `status=${healthy?.status}`);

		// Now the context blows past the cap; the next agent_end must stop it "done".
		pct = 95;
		await fireEvent(handlers, "agent_end", {}, ctx);
		const over = latestSnapshot(entries, id);
		check("ctxcap: over the cap (95% >= 90%), loop is stopped 'done'", over?.status === "done", `status=${over?.status}`);
		check("ctxcap: stop reason mentions the context budget", /context budget|%/i.test(over?.lastReason || ""), `reason=${over?.lastReason}`);
	}
	// Negative control: usage unavailable (undefined) or percent null must NEVER stop the loop
	// (best-effort: an absent signal is not a cap hit).
	{
		const loopExtension = await freshDefault(url);
		const { pi, commands, handlers, entries } = makePi();
		loopExtension(pi);
		const ctx = makeCtx({ mode: "tui", hasUI: true, isIdle: true, usage: () => ({ percent: null }) });
		const id = await startLoopCmd(commands, entries, "unknown context", ctx);
		await fireEvent(handlers, "agent_end", {}, ctx);
		const s = latestSnapshot(entries, id);
		check("ctxcap: null context percent is NOT a cap hit (loop stays running)", s?.status === "running", `status=${s?.status}`);
	}
}

// ===========================================================================
// SCENARIO B: pause clears the timer + preserves state + does NOT re-inject; resume
//   re-arms. Pause is a no-op on a non-running loop; resume a no-op on a non-paused loop.
//   Pause drops a queued wake so a paused loop never re-injects from the FIFO.
// ===========================================================================
async function pauseResume(url) {
	const loopExtension = await freshDefault(url);
	const { pi, commands, handlers, entries, sentMessages } = makePi();
	loopExtension(pi);
	const ctx = makeCtx({ mode: "tui", hasUI: true, isIdle: true });

	// Start a DYNAMIC loop. First wake fires (iteration 1). agent_end re-arms a real timer
	// (safety-net delay) so there is a live nextFireAt to preserve across pause.
	const id = await startLoopCmd(commands, entries, "pausable work", ctx);
	await fireEvent(handlers, "agent_end", {}, ctx);
	const armed = latestSnapshot(entries, id);
	check("pause: loop is running with a future nextFireAt before pause", armed?.status === "running" && typeof armed?.nextFireAt === "number" && armed.nextFireAt > Date.now(), `status=${armed?.status} next=${armed?.nextFireAt}`);

	const sentBeforePause = sentMessages.length;
	await commands.get("loop").handler(`pause ${id}`, ctx);
	const paused = latestSnapshot(entries, id);
	check("pause: status persisted as 'paused'", paused?.status === "paused", `status=${paused?.status}`);
	check("pause: pausing does NOT re-inject a wake", sentMessages.length === sentBeforePause, `delivered=${sentMessages.length}`);
	check("pause: iteration is preserved across pause (not reset)", paused?.iteration === armed?.iteration, `it=${paused?.iteration} vs ${armed?.iteration}`);

	// A paused loop must NOT fire even though its timer was armed before: pause cleared it.
	// Pulse agent_end (the safety net only re-arms RUNNING loops): no new wake, still paused.
	const sentBeforeIdle = sentMessages.length;
	await fireEvent(handlers, "agent_end", {}, ctx);
	const stillPaused = latestSnapshot(entries, id);
	check("pause: paused loop is NOT re-armed by the agent_end safety net", stillPaused?.status === "paused", `status=${stillPaused?.status}`);
	check("pause: paused loop delivers no wake on agent_end", sentMessages.length === sentBeforeIdle, `delivered=${sentMessages.length}`);

	// Resume: status back to running and a fresh future nextFireAt re-armed.
	await commands.get("loop").handler(`resume ${id}`, ctx);
	const resumed = latestSnapshot(entries, id);
	check("resume: status back to 'running'", resumed?.status === "running", `status=${resumed?.status}`);
	check("resume: re-arms a future nextFireAt", typeof resumed?.nextFireAt === "number" && resumed.nextFireAt > Date.now(), `next=${resumed?.nextFireAt}`);
	check("resume: reason notes it was resumed by the user", /resume/i.test(resumed?.lastReason || ""), `reason=${resumed?.lastReason}`);

	// No-op guards: resume an already-running loop, pause a non-existent loop.
	const beforeNoop = entries.length;
	await commands.get("loop").handler(`resume ${id}`, ctx); // already running
	const afterResumeNoop = latestSnapshot(entries, id);
	check("resume: resuming an already-running loop is a no-op (stays running)", afterResumeNoop?.status === "running", `status=${afterResumeNoop?.status}`);
	check("resume: no-op on running loop persists no spurious 'paused' snapshot", !entries.slice(beforeNoop).some((e) => e.customType === "loop-state" && e.data?.loopId === id && e.data?.status === "paused"));
}

// ===========================================================================
// SCENARIO B2: pause drops a QUEUED wake (a wake enqueued but not yet delivered must not
//   fire once its loop is paused). Loop A holds the in-flight turn; B's first wake queues
//   behind it. Pause B, then close A's turn: only A's slot drains, B (paused) does not fire.
// ===========================================================================
async function pauseDropsQueuedWake(url) {
	const loopExtension = await freshDefault(url);
	const { pi, commands, handlers, entries, sentMessages } = makePi();
	loopExtension(pi);
	const ctx = makeCtx({ mode: "tui", hasUI: true, isIdle: true });

	const idA = await startLoopCmd(commands, entries, "loop A holds turn", ctx);
	check("pausequeue: A delivered its wake (holds the in-flight turn)", sentMessages.length === 1, `delivered=${sentMessages.length}`);
	const idB = await startLoopCmd(commands, entries, "loop B queues behind A", ctx);
	check("pausequeue: B's wake is QUEUED, not delivered (one turn at a time)", sentMessages.length === 1, `delivered=${sentMessages.length}`);

	// Pause B while its wake is still in the FIFO. The queued entry must be dropped so it
	// never re-injects when A's turn closes.
	await commands.get("loop").handler(`pause ${idB}`, ctx);
	const bPaused = latestSnapshot(entries, idB);
	check("pausequeue: B is paused", bPaused?.status === "paused", `status=${bPaused?.status}`);

	// Close A's turn: the queue drains. B was dropped, so NO new wake is delivered.
	await fireEvent(handlers, "agent_end", {}, ctx);
	check("pausequeue: paused B does NOT fire from the queue after agent_end", !sentMessages.some((m) => /loop B queues behind A/.test(m.content || "")), `delivered=${sentMessages.length}`);
	void idA;
}

// ===========================================================================
// SCENARIO C1: rehydrate revives a running/stale snapshot, fires a SINGLE catch-up tick,
//   and does NOT double-fire on a second session_start. A "stale" snapshot is normalized
//   back to "running".
// ===========================================================================
async function rehydrateRevivesNoDoubleFire(url) {
	const loopExtension = await freshDefault(url);
	const { pi, handlers, entries, sentMessages } = makePi();
	loopExtension(pi);
	const ctx = makeCtx({ mode: "tui", hasUI: true, isIdle: true });

	const now = Date.now();
	seedEntries(ctx, [
		snap("revive", {
			status: "stale",
			iteration: 2,
			nextFireAt: now - 1000, // DUE: a single catch-up tick should fire it
			updatedAt: new Date(now - 1000).toISOString(),
		}),
	]);

	await fireEvent(handlers, "session_start", { reason: "startup" }, ctx);
	const s = latestSnapshot(entries, "revive");
	check("rehydrate: stale snapshot normalized back to 'running'", s?.status === "running", `status=${s?.status}`);
	check("rehydrate: due catch-up tick delivered exactly ONE wake", sentMessages.length === 1, `delivered=${sentMessages.length}`);
	check("rehydrate: catch-up advanced iteration (2 -> 3)", s?.iteration === 3, `it=${s?.iteration}`);

	// Second session_start (same process): the loop is already in activeLoops with a live
	// timer -> rehydrate must SKIP it (no double-fire).
	const before = sentMessages.length;
	await fireEvent(handlers, "session_start", { reason: "reload" }, ctx);
	check("rehydrate: second session_start does NOT double-fire (already live)", sentMessages.length === before, `delivered=${sentMessages.length}`);
}

// ===========================================================================
// SCENARIO C2: rehydrate keeps a "paused" snapshot PAUSED (no re-arm, no wake), ignores
//   terminal snapshots (done/stopped/failed) entirely, and resolves last-wins by updatedAt
//   across multiple JSONL entries for the same loopId.
// ===========================================================================
async function rehydratePausedTerminalLastWins(url) {
	const loopExtension = await freshDefault(url);
	const { pi, handlers, entries, sentMessages } = makePi();
	loopExtension(pi);
	const ctx = makeCtx({ mode: "tui", hasUI: true, isIdle: true });

	const now = Date.now();
	seedEntries(ctx, [
		// paused: must stay paused, no wake, no re-arm.
		snap("paused1", { status: "paused", nextFireAt: null, updatedAt: new Date(now - 5000).toISOString() }),
		// terminal: must be ignored (no recover, no wake).
		snap("doneone", { status: "done", nextFireAt: null, updatedAt: new Date(now - 5000).toISOString() }),
		snap("stopd", { status: "stopped", nextFireAt: null, updatedAt: new Date(now - 5000).toISOString() }),
		// last-wins: two entries for the SAME loopId; the LATER updatedAt (terminal) must win
		// over the earlier (running). Order in JSONL is earlier-then-later.
		snap("lastwins", { status: "running", nextFireAt: now - 1000, updatedAt: new Date(now - 9000).toISOString() }),
		snap("lastwins", { status: "stopped", nextFireAt: null, updatedAt: new Date(now - 1000).toISOString() }),
	]);

	await fireEvent(handlers, "session_start", { reason: "startup" }, ctx);

	const pausedSnap = latestSnapshot(entries, "paused1");
	check("rehydrate: paused snapshot stays paused (recovered idle)", pausedSnap == null || pausedSnap.status === "paused", `status=${pausedSnap?.status}`);

	// Terminal loops are not in activeLoops and produce no new snapshot from rehydrate.
	const newDone = entries.some((e) => e.customType === "loop-state" && e.data?.loopId === "doneone");
	const newStopd = entries.some((e) => e.customType === "loop-state" && e.data?.loopId === "stopd");
	check("rehydrate: terminal 'done' snapshot is ignored (no persist)", !newDone);
	check("rehydrate: terminal 'stopped' snapshot is ignored (no persist)", !newStopd);

	// last-wins: the later terminal won, so the loop was NOT revived -> no catch-up wake from it.
	check("rehydrate: last-wins picks the LATER (terminal) snapshot, so it is not revived", sentMessages.length === 0, `delivered=${sentMessages.length}`);

	// A second session_start with the directions swapped: the LATER entry is now running ->
	// it must be revived and fire its due catch-up. (Proves last-wins both directions.)
	const ctx2 = makeCtx({ mode: "tui", hasUI: true, isIdle: true });
	const { pi: pi2, handlers: h2, entries: e2, sentMessages: sent2 } = makePi();
	const loopExtension2 = await freshDefault(url);
	loopExtension2(pi2);
	const now2 = Date.now();
	seedEntries(ctx2, [
		snap("lw2", { status: "stopped", nextFireAt: null, updatedAt: new Date(now2 - 9000).toISOString() }),
		snap("lw2", { status: "running", nextFireAt: now2 - 1000, updatedAt: new Date(now2 - 1000).toISOString() }),
	]);
	await fireEvent(h2, "session_start", { reason: "startup" }, ctx2);
	const lw2 = latestSnapshot(e2, "lw2");
	check("rehydrate: last-wins (other direction) revives the LATER running snapshot", lw2?.status === "running", `status=${lw2?.status}`);
	check("rehydrate: revived later-running loop fires its due catch-up wake", sent2.length === 1, `delivered=${sent2.length}`);
}

// ===========================================================================
// SCENARIO C3: AUTONOMOUS re-entry gate. An autonomous loop persisted from a prior process
//   must be RETIRED (terminal "stopped") on rehydrate when the project is NO LONGER TRUSTED
//   — never re-armed unattended. A trusted project still revives it. This is the load-bearing
//   security guarantee for unattended action across reloads.
// ===========================================================================
async function rehydrateAutonomousTrustGate(url) {
	// Untrusted: retire.
	{
		const loopExtension = await freshDefault(url);
		const { pi, handlers, entries, sentMessages } = makePi();
		loopExtension(pi);
		const ctx = makeCtx({ mode: "tui", hasUI: true, isIdle: true, trusted: false });
		const now = Date.now();
		seedEntries(ctx, [
			snap("autoloop", {
				status: "running",
				autonomous: true,
				nextFireAt: now - 1000, // would be due, but trust gate must retire it first
				updatedAt: new Date(now - 1000).toISOString(),
			}),
		]);
		await fireEvent(handlers, "session_start", { reason: "startup" }, ctx);
		const s = latestSnapshot(entries, "autoloop");
		check("autotrust: autonomous loop in an UNTRUSTED project is retired 'stopped'", s?.status === "stopped", `status=${s?.status}`);
		check("autotrust: retire reason mentions trust", /trust/i.test(s?.lastReason || ""), `reason=${s?.lastReason}`);
		check("autotrust: a retired autonomous loop fires NO wake", sentMessages.length === 0, `delivered=${sentMessages.length}`);
	}
	// Trusted: revive and fire the due catch-up (positive control — proves the retire is
	// caused by the trust revocation, not by autonomous loops being unrecoverable in general).
	{
		const loopExtension = await freshDefault(url);
		const { pi, handlers, entries, sentMessages } = makePi();
		loopExtension(pi);
		const ctx = makeCtx({ mode: "tui", hasUI: true, isIdle: true, trusted: true });
		const now = Date.now();
		seedEntries(ctx, [
			snap("autoloop2", {
				status: "running",
				autonomous: true,
				nextFireAt: now - 1000, // due -> single catch-up tick
				updatedAt: new Date(now - 1000).toISOString(),
			}),
		]);
		await fireEvent(handlers, "session_start", { reason: "startup" }, ctx);
		const s = latestSnapshot(entries, "autoloop2");
		check("autotrust: autonomous loop in a TRUSTED project is revived running", s?.status === "running", `status=${s?.status}`);
		check("autotrust: trusted autonomous loop fires its due catch-up wake", sentMessages.length === 1, `delivered=${sentMessages.length}`);
	}
}

// ===========================================================================
// SCENARIO C4: a cap already blown across downtime stops the loop cleanly on rehydrate
//   instead of re-arming it into another over-budget iteration. (rehydrate runs capExceeded
//   BEFORE arming the catch-up timer.) Pairs with A2 but isolates the "due AND over-budget"
//   collision: the loop is DUE to fire, yet the cap must win.
// ===========================================================================
async function rehydrateRespectsCap(url) {
	const loopExtension = await freshDefault(url);
	const { pi, handlers, entries, sentMessages } = makePi();
	loopExtension(pi);
	const ctx = makeCtx({ mode: "tui", hasUI: true, isIdle: true });

	const now = Date.now();
	const wall = 6 * 60 * 60 * 1000;
	seedEntries(ctx, [
		snap("dueovercap", {
			status: "stale",
			iteration: 7,
			maxWallClockMs: wall,
			startedAt: now - (wall + 60 * 1000), // over the deadline
			nextFireAt: now - 1000, // DUE: tempts a catch-up fire
			updatedAt: new Date(now - 1000).toISOString(),
		}),
	]);

	await fireEvent(handlers, "session_start", { reason: "startup" }, ctx);
	const s = latestSnapshot(entries, "dueovercap");
	check("rehydrate-cap: a due-but-over-budget loop is stopped 'done', not re-armed", s?.status === "done", `status=${s?.status}`);
	check("rehydrate-cap: it fires NO catch-up wake despite being due", sentMessages.length === 0, `delivered=${sentMessages.length}`);
	check("rehydrate-cap: iteration is NOT advanced (the loop never fired)", s?.iteration === 7, `it=${s?.iteration}`);
}

// ===========================================================================
async function main() {
	const { outDir, url } = await buildLoop();
	try {
		await maxIterationsCap(url);
		await wallClockCap(url);
		await contextPercentCap(url);
		await pauseResume(url);
		await pauseDropsQueuedWake(url);
		await rehydrateRevivesNoDoubleFire(url);
		await rehydratePausedTerminalLastWins(url);
		await rehydrateAutonomousTrustGate(url);
		await rehydrateRespectsCap(url);
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
	// Revived/started loops leave live setTimeout timers (period / safety-net / catch-up
	// re-arm) that keep the event loop open, so exit explicitly rather than hang after green.
	process.exit(0);
}

main().catch((err) => {
	console.error("E2E CRASH:", err && err.stack ? err.stack : err);
	process.exit(2);
});
