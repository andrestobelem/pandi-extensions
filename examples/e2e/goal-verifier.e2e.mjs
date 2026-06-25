/**
 * Durable behavioral e2e for the INDEPENDENT VERIFIER of extensions/goal.ts.
 *
 * Why this file exists
 * --------------------
 * `npm test` is a TYPECHECK only (`tsc --noEmit` over the four extensions). It proves the
 * code compiles; it proves NOTHING about runtime behavior. The single most consequential
 * decision /goal makes is: "is this objective DONE?" — and the whole design hinges on a
 * skeptical INDEPENDENT verifier closing a goal ONLY on a real PASS. The verdict-parsing
 * path is where a silent regression is most dangerous:
 *   - A spurious PASS (e.g. trusting a prompt-echo of "VERDICT: PASS", or a non-zero exit
 *     that still printed PASS) = a FALSE "done": the goal closes unverified. That is the
 *     exact failure the independent verifier exists to prevent.
 *   - A malformed / missing / timed-out / crashed verdict must stay a CONSERVATIVE FAIL
 *     (never close), and FAILs under the cap must iterate, FAILs at the cap must block.
 * `tsc` sees none of this. This file pins the OBSERVABLE done/continue/blocked contract.
 *
 * The sibling pending #1 of the improvement loop ("extend e2e coverage to goal.ts: the
 * verifier and parseVerdict, where a parse error = a false done") — this is that file.
 *
 * How it works
 * ------------
 * Self-bootstrapping, same pattern as safety-gates.e2e.mjs: it esbuilds the CURRENT
 * extensions/goal.ts into an OS temp dir at run time (never a stale bundled copy), aliasing
 * the two external peer packages (typebox, @earendil-works/pi-coding-agent) to tiny local
 * stubs so it runs from a clean checkout with NO `npm install`. It then drives the REAL
 * registered `/goal` command + `goal_progress` tool against a mocked pi/ctx, and mocks
 * `pi.exec` (the verifier subprocess) to return crafted stdout / exit code / killed flag.
 * It asserts the OBSERVABLE outcome — the goal's final persisted `gstatus` (done / blocked /
 * continue→pursuing) — NOT a copy of the regex. So it tracks the source: if the verdict
 * logic drifts to close on a malformed judge, this suite goes red.
 *
 * Run it:
 *   node examples/e2e/goal-verifier.e2e.mjs
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
// Build the current goal extension to ESM in a temp dir, return import URL.
// ---------------------------------------------------------------------------
async function buildExtension(name) {
	const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-goal-e2e-"));

	// Tiny stubs for the two external peer packages. The exercised paths only need these
	// symbols for tool-schema declaration + state-dir resolution — never validation.
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
	return { outDir, url: pathToFileURL(out).href };
}

// A module keeps a singleton (activeGoals). Load a FRESH instance per scenario via a
// cache-busting query so scenarios never leak goal state into each other.
let _instance = 0;
async function freshDefault(url) {
	const mod = await import(`${url}?i=${_instance++}`);
	return mod.default;
}

// Let fire-and-forget async chains (`void beginIndependentVerification(...)`) settle. The
// verifier path is: tool.execute -> void beginIndependentVerification -> await
// runIndependentVerifier -> await pi.exec (our mock resolves immediately) -> stopGoal /
// advanceGoal. A few macrotask turns are more than enough; we also poll a predicate.
async function flush(predicate, tries = 50) {
	for (let i = 0; i < tries; i++) {
		await new Promise((r) => setImmediate(r));
		if (predicate && predicate()) return;
	}
}

// ---------------------------------------------------------------------------
// Mock pi + ctx. We capture every persisted "goal-state" snapshot (pi.appendEntry) so we
// can read the goal's FINAL gstatus — the observable outcome of the verdict logic. pi.exec
// is the verifier subprocess; each scenario sets execResult to the crafted result.
// ---------------------------------------------------------------------------
function makePi(execImpl) {
	const tools = new Map();
	const commands = new Map();
	const handlers = new Map();
	const states = []; // every appended goal-state snapshot, in order
	const execCalls = [];
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
		sendUserMessage: () => {},
		exec: async (cmd, args, opts) => {
			execCalls.push({ cmd, args, opts });
			return execImpl(cmd, args, opts);
		},
	};
	return { pi, tools, commands, handlers, states, execCalls };
}

function makeCtx({ cwd = REPO_ROOT } = {}) {
	return {
		mode: "tui",
		hasUI: true,
		cwd,
		isIdle: () => true,
		isProjectTrusted: () => false, // route sidecar writes under the (stubbed) agent dir
		getContextUsage: () => undefined,
		ui: {
			theme: { fg: (_c, s) => s },
			notify: () => {},
			setStatus: () => {},
			confirm: async () => true,
			select: async () => undefined,
		},
		sessionManager: { getEntries: () => [] },
	};
}

// The last persisted gstatus is the observable disposition of the goal.
function lastStatus(states) {
	return states.length ? states[states.length - 1].gstatus : undefined;
}

// Drive a goal from start to a CONFIRMED done so the next goal_progress({done}) escalates to
// the independent verifier. The flow is:
//   /goal <obj>               -> pursuing (fireGoal increments iteration, persists)
//   goal_progress({done})     -> verifying (first done never closes)
//   goal_progress({done})     -> verifying-independent -> spawns verifier (pi.exec)
// Returns the goal_progress tool so callers can keep poking it (for the cap scenarios).
async function driveToVerifier(goalUrl, execImpl) {
	const goalExtension = await freshDefault(goalUrl);
	const ctx = makeCtx();
	const built = makePi(execImpl);
	goalExtension(built.pi);

	built.commands.get("goal").handler("ship the feature -- the tests pass", ctx);
	const progress = built.tools.get("goal_progress");
	if (!progress) throw new Error("goal_progress tool not registered");

	// First done -> verifying (does NOT close).
	await progress.execute("tc1", { status: "done", assessment: "I believe all criteria are met." }, undefined, undefined, ctx);
	// Confirmed done from verifying -> verifying-independent -> launches the verifier.
	await progress.execute("tc2", { status: "done", assessment: "Confirmed after self-check." }, undefined, undefined, ctx);

	return { progress, ctx, ...built };
}

// ===========================================================================
// SCENARIO A: a clean PASS on the final line CLOSES the goal (done).
// ===========================================================================
async function passClosesGoal(goalUrl) {
	const exec = () => ({ code: 0, killed: false, stdout: "Criterion 1: PASS — tests run green.\nVERDICT: PASS", stderr: "" });
	const { states, execCalls } = await driveToVerifier(goalUrl, exec);
	await flush(() => lastStatus(states) === "done");
	check("verifier spawned exactly one subprocess", execCalls.length === 1, `calls=${execCalls.length}`);
	check("PASS on final line CLOSES goal (done)", lastStatus(states) === "done", `last=${lastStatus(states)}`);
}

// ===========================================================================
// SCENARIO B: a clean FAIL does NOT close; under the cap it iterates (continue),
// at the cap (default 2) it BLOCKS. This is the core "never a false done" guard.
// ===========================================================================
async function failIteratesThenBlocks(goalUrl) {
	const exec = () => ({ code: 0, killed: false, stdout: "Criterion 1: FAIL — no test asserts.\nVERDICT: FAIL", stderr: "" });
	const { progress, ctx, states } = await driveToVerifier(goalUrl, exec);

	// First independent FAIL (attempt 1/2): under the cap -> continue (re-armed as pursuing).
	await flush(() => lastStatus(states) === "pursuing");
	check("first FAIL does NOT close: iterates (continue→pursuing)", lastStatus(states) === "pursuing", `last=${lastStatus(states)}`);
	check("first FAIL is never 'done'", !states.some((s) => s.gstatus === "done"));

	// Re-declare done -> verifying -> confirmed done -> second independent FAIL (2/2 = cap) -> blocked.
	await progress.execute("tcB1", { status: "done", assessment: "Re-declaring done." }, undefined, undefined, ctx);
	await progress.execute("tcB2", { status: "done", assessment: "Confirmed again." }, undefined, undefined, ctx);
	await flush(() => lastStatus(states) === "blocked");
	check("FAIL at the cap BLOCKS the goal (needs a human)", lastStatus(states) === "blocked", `last=${lastStatus(states)}`);
	check("a FAILing verifier NEVER closes the goal as done", !states.some((s) => s.gstatus === "done"));
}

// ===========================================================================
// SCENARIO C: malformed / missing verdict = conservative FAIL (does NOT close).
// These are the parseVerdict edge cases where a naive parser could close falsely.
// ===========================================================================
async function malformedNeverCloses(goalUrl) {
	const cases = [
		["empty stdout", ""],
		["only whitespace", "   \n\n  "],
		["prose with no VERDICT line", "Looks complete to me, everything checks out."],
		["lowercase non-matching keyword", "verdict pass maybe"],
		["VERDICT with junk value", "VERDICT: MAYBE"],
		["VERDICT: PASS not on a recognizable line shape", "VERDICTPASS"],
	];
	for (const [label, stdout] of cases) {
		const { states } = await driveToVerifier(goalUrl, () => ({ code: 0, killed: false, stdout, stderr: "" }));
		await flush(() => lastStatus(states) === "pursuing");
		check(`malformed (${label}) does NOT close as done`, !states.some((s) => s.gstatus === "done"), `last=${lastStatus(states)}`);
		check(`malformed (${label}) iterates conservatively (continue→pursuing)`, lastStatus(states) === "pursuing", `last=${lastStatus(states)}`);
	}
}

// ===========================================================================
// SCENARIO D: the PROMPT-ECHO attack. The verifier prompt itself contains both
// "VERDICT: PASS" and "VERDICT: FAIL" as instruction lines. If the verifier echoes
// those instructions but its ACTUAL final-line verdict is FAIL, the goal must NOT
// close. The final-line anchor is the defense; a whole-text "last match" would be
// fooled here. This pins that the closing verdict is the FINAL line.
// ===========================================================================
async function promptEchoCannotForgePass(goalUrl) {
	// Echoes the instruction block (PASS appears EARLIER), real closing verdict is FAIL.
	const echoed =
		"OUTPUT: a short per-criterion judgment, THEN on the FINAL line emit EXACTLY one of:\n" +
		"VERDICT: PASS   (only if EVERY criterion is met with evidence)\n" +
		"VERDICT: FAIL   (if ANY criterion is unmet)\n" +
		"Criterion 1: the tests do not actually assert anything.\n" +
		"VERDICT: FAIL";
	const { states } = await driveToVerifier(goalUrl, () => ({ code: 0, killed: false, stdout: echoed, stderr: "" }));
	await flush(() => lastStatus(states) === "pursuing");
	check("prompt-echo of 'VERDICT: PASS' earlier does NOT close (final line FAIL wins)", !states.some((s) => s.gstatus === "done"), `last=${lastStatus(states)}`);
	check("prompt-echo case iterates as a FAIL (continue→pursuing)", lastStatus(states) === "pursuing", `last=${lastStatus(states)}`);

	// Symmetric positive control: a genuine final-line PASS, even with instruction text above
	// it (which also contains 'VERDICT: FAIL'), DOES close. Proves the anchor is final-line,
	// not "any PASS present" and not "any FAIL present".
	const genuine =
		"VERDICT: PASS   (only if EVERY criterion is met with evidence)\n" +
		"VERDICT: FAIL   (if ANY criterion is unmet)\n" +
		"Criterion 1: PASS — verified the test file asserts on output.\n" +
		"VERDICT: PASS";
	const { states: s2 } = await driveToVerifier(goalUrl, () => ({ code: 0, killed: false, stdout: genuine, stderr: "" }));
	await flush(() => lastStatus(s2) === "done");
	check("genuine final-line PASS closes despite instruction echo above it", lastStatus(s2) === "done", `last=${lastStatus(s2)}`);
}

// ===========================================================================
// SCENARIO E: a non-zero EXIT with a PASS line is contradictory -> treated as FAIL.
// A crashed/aborted judge that still printed "VERDICT: PASS" must NOT close the goal.
// ===========================================================================
async function nonZeroExitWithPassIsFail(goalUrl) {
	const exec = () => ({ code: 1, killed: false, stdout: "partial output...\nVERDICT: PASS", stderr: "boom" });
	const { states } = await driveToVerifier(goalUrl, exec);
	await flush(() => lastStatus(states) === "pursuing");
	check("non-zero exit + PASS line does NOT close (contradictory→FAIL)", !states.some((s) => s.gstatus === "done"), `last=${lastStatus(states)}`);
	check("non-zero exit + PASS iterates as FAIL (continue→pursuing)", lastStatus(states) === "pursuing", `last=${lastStatus(states)}`);
}

// ===========================================================================
// SCENARIO F: timeout (killed) and a thrown exec error are conservative FAILs.
// The verifier never returning a clean PASS must never close the goal.
// ===========================================================================
async function timeoutAndThrowAreFail(goalUrl) {
	// Killed (timeout): even a PASS line in partial stdout must not close.
	const killed = await driveToVerifier(goalUrl, () => ({ code: null, killed: true, stdout: "VERDICT: PASS", stderr: "" }));
	await flush(() => lastStatus(killed.states) === "pursuing");
	check("timeout (killed) does NOT close as done", !killed.states.some((s) => s.gstatus === "done"), `last=${lastStatus(killed.states)}`);
	check("timeout (killed) iterates as FAIL (continue→pursuing)", lastStatus(killed.states) === "pursuing", `last=${lastStatus(killed.states)}`);

	// exec throws (could not spawn): conservative FAIL.
	const thrown = await driveToVerifier(goalUrl, () => {
		throw new Error("spawn pi ENOENT");
	});
	await flush(() => lastStatus(thrown.states) === "pursuing");
	check("exec throw (spawn failure) does NOT close as done", !thrown.states.some((s) => s.gstatus === "done"), `last=${lastStatus(thrown.states)}`);
	check("exec throw iterates as FAIL (continue→pursuing)", lastStatus(thrown.states) === "pursuing", `last=${lastStatus(thrown.states)}`);
}

// ===========================================================================
// SCENARIO G: the FIRST `done` (from pursuing) never closes — it goes to a
// self-verification turn first. Independent verification is a SECOND gate, not the
// first. This pins that a single `done` can never short-circuit either gate.
// ===========================================================================
async function firstDoneNeverClosesNorVerifies(goalUrl) {
	const goalExtension = await freshDefault(goalUrl);
	const ctx = makeCtx();
	let execCount = 0;
	const built = makePi(() => {
		execCount += 1;
		return { code: 0, killed: false, stdout: "VERDICT: PASS", stderr: "" };
	});
	goalExtension(built.pi);
	built.commands.get("goal").handler("do the thing -- it works", ctx);
	const progress = built.tools.get("goal_progress");

	await progress.execute("tc1", { status: "done", assessment: "First done." }, undefined, undefined, ctx);
	await flush();
	check("first done -> verifying (NOT done, NOT closed)", lastStatus(built.states) === "verifying", `last=${lastStatus(built.states)}`);
	check("first done does NOT spawn the independent verifier yet", execCount === 0, `execCount=${execCount}`);
	check("first done never reaches 'done'", !built.states.some((s) => s.gstatus === "done"));
}

// ===========================================================================
async function main() {
	const { outDir, url } = await buildExtension("goal");
	try {
		await passClosesGoal(url);
		await failIteratesThenBlocks(url);
		await malformedNeverCloses(url);
		await promptEchoCannotForgePass(url);
		await nonZeroExitWithPassIsFail(url);
		await timeoutAndThrowAreFail(url);
		await firstDoneNeverClosesNorVerifies(url);
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
	// Goals re-arm with setTimeout timers on the continue path, which keep the event loop
	// open; exit explicitly rather than hang after a green run.
	process.exit(0);
}

main().catch((err) => {
	console.error("E2E CRASH:", err && err.stack ? err.stack : err);
	process.exit(2);
});
