/**
 * Characterization integration test for extensions/pi-goal/verifier.ts (the P1
 * independent adversarial verifier cluster).
 *
 * Why this file exists
 * --------------------
 * `npm test` is a TYPECHECK only; it proves nothing about runtime behavior. verifier.ts
 * owns three load-bearing contracts that a silent regression could quietly break:
 *
 *   1. parseVerdict's CONSERVATIVE parse: it anchors on the last non-empty line, and only
 *      when that line carries no verdict does it fall back to a whole-text scan where the
 *      LAST `VERDICT:` match wins. This fallback is what keeps a goal from closing on a
 *      malformed judge — pinning "last match wins" pins the contract.
 *   2. makeIndependentVerifierPrompt's criteria branch: with NO criteria (neither
 *      successCriteria nor derivedCriteria) the prompt must say "none were stated
 *      explicitly" and must NOT emit a definition-of-done criteria block.
 *   3. runIndependentVerifier's exec wiring: the subprocess is invoked with cwd=ctx.cwd,
 *      timeout=goal.verifierTimeoutMs, and signal=goal.controller.signal.
 *
 * parseVerdict and makeIndependentVerifierPrompt are NOT exported, so we drive them through
 * the EXPORTED runIndependentVerifier: we control the verifier's stdout (and exit code /
 * killed flag) via a pi.exec mock, and we CAPTURE the prompt (the last argv element) and the
 * exec opts (the 3rd arg) the function actually passes. This asserts the real current
 * behavior of the source; if an assertion fails, the SOURCE is the source of truth.
 *
 * Run it:
 *   node extensions/pi-goal/tests/integration/verifier-coverage.test.mjs
 *
 * Exit code 0 = all checks passed; 1 = a behavioral check failed; 2 = harness crashed.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExtension, createChecker, loadModule } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// extensions/pi-goal/tests/integration/ -> repo root is four levels up.
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

const { check, counts } = createChecker();

// verifier.ts only `import type`s the SDK; its runtime imports (constants.js, prompts.js,
// types.js) are pure leaves with no external module deps, so it bundles with NO stubs.
async function buildVerifier() {
	return await buildExtension({
		name: "pi-goal-verifier-coverage",
		src: path.join(REPO_ROOT, "extensions", "pi-goal", "verifier.ts"),
		outName: "verifier.mjs",
		npx: "--yes",
	});
}

// A minimally-complete ActiveGoal (only the fields the verifier reads).
function makeGoal(overrides = {}) {
	return {
		goalId: "g0001",
		objective: "ship the feature",
		successCriteria: undefined,
		derivedCriteria: undefined,
		assessments: [],
		verifierTimeoutMs: 120000,
		verifierTools: ["read", "grep", "find", "ls"],
		controller: new AbortController(),
		...overrides,
	};
}

// pi.exec mock: records every call ({cmd,args,opts}) and returns a caller-supplied result.
function makePi(result) {
	const calls = [];
	const pi = {
		exec: async (cmd, args, opts) => {
			calls.push({ cmd, args, opts });
			return typeof result === "function" ? result(cmd, args, opts) : result;
		},
	};
	return { pi, calls };
}

function makeCtx(overrides = {}) {
	return { cwd: "/tmp/verifier-cwd", ...overrides };
}

// The prompt is always the LAST argv element buildVerifierArgs appends.
function capturedPrompt(calls) {
	const args = calls[0].args;
	return args[args.length - 1];
}

// ===========================================================================
// GAP 1: parseVerdict whole-text fallback — last non-empty line has NO verdict, so the
// whole-text scan runs and the LAST `VERDICT:` match wins (here PASS, after an earlier FAIL).
// ===========================================================================
async function fallbackLastMatchWins(mod) {
	const stdout = "VERDICT: FAIL\nVERDICT: PASS\n(trailing prose with no verdict)";
	const { pi } = makePi({ code: 0, killed: false, stdout, stderr: "" });
	const verdict = await mod.runIndependentVerifier(pi, makeCtx(), makeGoal());
	check(
		"fallback scan: last non-empty line has no verdict → last whole-text match (PASS) wins",
		verdict.pass === true,
		`pass=${verdict.pass}`,
	);
	check("fallback PASS is a parsed verdict (unparsed=false)", verdict.unparsed === false, `unparsed=${verdict.unparsed}`);
}

// Companion: when the FINAL non-empty line DOES carry a verdict, that line wins over any
// earlier match (anchors on the last non-empty line first). Pins the non-fallback path too.
async function finalLineAnchorsVerdict(mod) {
	const stdout = "VERDICT: PASS\nVERDICT: FAIL";
	const { pi } = makePi({ code: 0, killed: false, stdout, stderr: "" });
	const verdict = await mod.runIndependentVerifier(pi, makeCtx(), makeGoal());
	check(
		"final non-empty line carries the verdict (FAIL) and wins over earlier PASS",
		verdict.pass === false,
		`pass=${verdict.pass}`,
	);
}

// Companion: no parseable verdict anywhere → conservative FAIL flagged unparsed.
async function noVerdictIsConservativeFail(mod) {
	const { pi } = makePi({ code: 0, killed: false, stdout: "the judge rambled but never voted", stderr: "" });
	const verdict = await mod.runIndependentVerifier(pi, makeCtx(), makeGoal());
	check("no parseable verdict → conservative FAIL", verdict.pass === false, `pass=${verdict.pass}`);
	check("no parseable verdict → unparsed=true", verdict.unparsed === true, `unparsed=${verdict.unparsed}`);
}

// ===========================================================================
// GAP 2: makeIndependentVerifierPrompt criteria branch — no criteria stated.
// ===========================================================================
async function promptNoCriteriaBranch(mod) {
	const { pi, calls } = makePi({ code: 0, killed: false, stdout: "VERDICT: PASS", stderr: "" });
	await mod.runIndependentVerifier(pi, makeCtx(), makeGoal({ successCriteria: undefined, derivedCriteria: undefined }));
	const prompt = capturedPrompt(calls);
	check(
		"no-criteria prompt contains 'none were stated explicitly'",
		prompt.includes("none were stated explicitly"),
		"missing inference clause",
	);
	check(
		"no-criteria prompt omits the definition-of-done criteria block",
		!prompt.includes("SUCCESS CRITERIA (definition-of-done):"),
		"unexpected definition-of-done block",
	);
}

// Companion: criteria present → definition-of-done block with the criteria text; no inference clause.
async function promptWithCriteriaBranch(mod) {
	const { pi, calls } = makePi({ code: 0, killed: false, stdout: "VERDICT: PASS", stderr: "" });
	await mod.runIndependentVerifier(pi, makeCtx(), makeGoal({ successCriteria: "the tests pass" }));
	const prompt = capturedPrompt(calls);
	check(
		"with-criteria prompt contains the definition-of-done block",
		prompt.includes("SUCCESS CRITERIA (definition-of-done):"),
		"missing definition-of-done block",
	);
	check("with-criteria prompt embeds the criteria text", prompt.includes("the tests pass"), "missing criteria text");
	check(
		"with-criteria prompt omits the 'none were stated' inference clause",
		!prompt.includes("none were stated explicitly"),
		"unexpected inference clause",
	);
}

// derivedCriteria is used when successCriteria is absent (effectiveCriteria fallback).
async function promptUsesDerivedCriteria(mod) {
	const { pi, calls } = makePi({ code: 0, killed: false, stdout: "VERDICT: PASS", stderr: "" });
	await mod.runIndependentVerifier(
		pi,
		makeCtx(),
		makeGoal({ successCriteria: undefined, derivedCriteria: "lint is clean" }),
	);
	const prompt = capturedPrompt(calls);
	check(
		"derivedCriteria fills the definition-of-done when successCriteria is absent",
		prompt.includes("SUCCESS CRITERIA (definition-of-done):") && prompt.includes("lint is clean"),
		"derivedCriteria not used",
	);
}

// ===========================================================================
// GAP 3: runIndependentVerifier exec wiring — cwd, timeout, signal.
// ===========================================================================
async function execWiring(mod) {
	const goal = makeGoal({ verifierTimeoutMs: 4242 });
	const ctx = makeCtx({ cwd: "/tmp/some-workspace" });
	const { pi, calls } = makePi({ code: 0, killed: false, stdout: "VERDICT: PASS", stderr: "" });
	await mod.runIndependentVerifier(pi, ctx, goal);
	check("exec called exactly once", calls.length === 1, `calls=${calls.length}`);
	const opts = calls[0].opts;
	check("exec opts.timeout === goal.verifierTimeoutMs", opts.timeout === 4242, `timeout=${opts.timeout}`);
	check("exec opts.cwd === ctx.cwd", opts.cwd === "/tmp/some-workspace", `cwd=${opts.cwd}`);
	check(
		"exec opts.signal === goal.controller.signal",
		opts.signal === goal.controller.signal,
		"signal not threaded from controller",
	);
	// The argv guarantees a read-only, sessionless judge run.
	const args = calls[0].args;
	check("argv requests a one-shot sessionless run (-p --no-session)", args.includes("-p") && args.includes("--no-session"), JSON.stringify(args.slice(0, 4)));
	check("argv passes the read-only --tools allowlist", args.includes("--tools") && args.includes("read,grep,find,ls"), JSON.stringify(args));
}

// Empty verifierTools must DISABLE tools (--no-tools), never fall through to a mutating default.
async function emptyToolsDisablesTools(mod) {
	const { pi, calls } = makePi({ code: 0, killed: false, stdout: "VERDICT: PASS", stderr: "" });
	await mod.runIndependentVerifier(pi, makeCtx(), makeGoal({ verifierTools: [] }));
	const args = calls[0].args;
	check("empty verifierTools → --no-tools (never a mutating default)", args.includes("--no-tools") && !args.includes("--tools"), JSON.stringify(args));
}

// ===========================================================================
// Extra failure-mode characterization (cheap, deterministic).
// ===========================================================================
async function killedIsConservativeFail(mod) {
	const { pi } = makePi({ code: 0, killed: true, stdout: "VERDICT: PASS", stderr: "" });
	const verdict = await mod.runIndependentVerifier(pi, makeCtx(), makeGoal({ verifierTimeoutMs: 99 }));
	check("killed (timeout) → FAIL even with a PASS line", verdict.pass === false, `pass=${verdict.pass}`);
	check("killed → unparsed=true", verdict.unparsed === true, `unparsed=${verdict.unparsed}`);
	check("killed feedback names the timeout budget", verdict.feedback.includes("99ms"), verdict.feedback);
}

async function nonZeroExitWithPassIsFail(mod) {
	const { pi } = makePi({ code: 1, killed: false, stdout: "VERDICT: PASS", stderr: "" });
	const verdict = await mod.runIndependentVerifier(pi, makeCtx(), makeGoal());
	check("non-zero exit + PASS line is contradictory → FAIL", verdict.pass === false, `pass=${verdict.pass}`);
	check("non-zero-exit override is a parsed verdict (unparsed=false)", verdict.unparsed === false, `unparsed=${verdict.unparsed}`);
}

async function thrownExecIsConservativeFail(mod) {
	const { pi } = makePi(() => {
		throw new Error("boom: spawn failed");
	});
	const verdict = await mod.runIndependentVerifier(pi, makeCtx(), makeGoal());
	check("thrown exec → conservative FAIL", verdict.pass === false, `pass=${verdict.pass}`);
	check("thrown exec → unparsed=true", verdict.unparsed === true, `unparsed=${verdict.unparsed}`);
	check("thrown exec feedback names the error", verdict.feedback.includes("boom: spawn failed"), verdict.feedback);
}

// ===========================================================================
async function main() {
	const { outDir, url } = await buildVerifier();
	try {
		const mod = await loadModule(url);
		if (typeof mod.runIndependentVerifier !== "function") {
			throw new Error("runIndependentVerifier export missing");
		}
		await fallbackLastMatchWins(mod);
		await finalLineAnchorsVerdict(mod);
		await noVerdictIsConservativeFail(mod);
		await promptNoCriteriaBranch(mod);
		await promptWithCriteriaBranch(mod);
		await promptUsesDerivedCriteria(mod);
		await execWiring(mod);
		await emptyToolsDisablesTools(mod);
		await killedIsConservativeFail(mod);
		await nonZeroExitWithPassIsFail(mod);
		await thrownExecIsConservativeFail(mod);
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
