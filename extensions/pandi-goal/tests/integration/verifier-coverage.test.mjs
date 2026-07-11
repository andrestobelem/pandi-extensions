/**
 * Test de integración de caracterización para extensions/pandi-goal/verifier.ts (el cluster P1
 * del verificador adversarial independiente).
 *
 * Por qué existe este archivo
 * --------------------
 * `npm test` solo hace TYPECHECK; no prueba nada sobre comportamiento runtime. verifier.ts
 * posee tres contratos críticos que una regresión silenciosa podría romper sin ruido:
 *
 *   1. El parse CONSERVATIVE de parseVerdict: solo acepta una última línea no vacía que sea
 *      exactamente `VERDICT: PASS` o `VERDICT: FAIL`. Cualquier PASS incidental, trailing
 *      prose o salida sin veredicto final exacto queda como FAIL no parseado.
 *   2. La rama de criterios de makeIndependentVerifierPrompt: sin criterios (ni
 *      successCriteria ni derivedCriteria), el prompt debe decir "none were stated
 *      explicitly" y NO debe emitir un bloque de criterios definition-of-done.
 *   3. El wiring de exec de runIndependentVerifier: el subprocess se invoca con cwd=ctx.cwd,
 *      timeout=goal.verifierTimeoutMs y signal=goal.controller.signal.
 *
 * parseVerdict y makeIndependentVerifierPrompt NO se exportan, así que los ejercitamos a través
 * del runIndependentVerifier EXPORTADO: controlamos el stdout del verifier (y exit code /
 * flag killed) vía un mock pi.exec, y CAPTURAMOS el prompt (el último elemento de argv) y las
 * opts de exec (el 3er arg) que la función pasa realmente. Esto afirma el comportamiento real
 * actual de la fuente; si una aserción falla, la FUENTE es la fuente de verdad.
 *
 * Ejecución:
 *   node extensions/pandi-goal/tests/integration/verifier-coverage.test.mjs
 *
 * Código de salida 0 = todos los checks pasaron; 1 = falló un check de comportamiento; 2 = falló el harness.
 */

import * as fs from "node:fs/promises";
import { createChecker, loadModule } from "../../../shared/test/harness.mjs";
import { buildVerifier, makeExecPi, makeVerifierCtx, makeVerifierGoal } from "./goal-test-support.mjs";

const { check, counts } = createChecker();

// El prompt siempre es el ÚLTIMO elemento de argv que agrega buildVerifierArgs.
function capturedPrompt(execCalls) {
	const args = execCalls[0].args;
	return args[args.length - 1];
}

// ===========================================================================
// BRECHA 1: parseVerdict solo acepta un veredicto exacto en la última línea no vacía.
// ===========================================================================
async function incidentalPassWithTrailingProseIsUnparsed(mod) {
	const cases = [
		["later prose line", "Criterion: PASS with evidence.\nVERDICT: PASS\nBut one more thought."],
		["same-line prose", "Criterion: PASS with evidence.\nVERDICT: PASS because everything passed."],
	];
	for (const [label, stdout] of cases) {
		const { pi } = makeExecPi({ code: 0, killed: false, stdout, stderr: "" });
		const verdict = await mod.runIndependentVerifier(pi, makeVerifierCtx(), makeVerifierGoal());
		check(`${label}: incidental PASS + trailing prose → conservative FAIL`, verdict.pass === false);
		check(`${label}: incidental PASS + trailing prose → unparsed=true`, verdict.unparsed === true);
	}
}

async function multipleVerdictsUseExactFinalLine(mod) {
	const stdout = "VERDICT: PASS\nVERDICT: FAIL";
	const { pi } = makeExecPi({ code: 0, killed: false, stdout, stderr: "" });
	const verdict = await mod.runIndependentVerifier(pi, makeVerifierCtx(), makeVerifierGoal());
	check(
		"final non-empty line carries the verdict (FAIL) and wins over earlier PASS",
		verdict.pass === false,
		`pass=${verdict.pass}`,
	);
	check("exact final FAIL is parsed", verdict.unparsed === false, `unparsed=${verdict.unparsed}`);
}

async function exactFinalVerdictIsValid(mod) {
	const stdout = "Criterion: PASS with evidence.\n \tVERDICT: PASS \t\n\n";
	const { pi } = makeExecPi({ code: 0, killed: false, stdout, stderr: "" });
	const verdict = await mod.runIndependentVerifier(pi, makeVerifierCtx(), makeVerifierGoal());
	check("exact final PASS with surrounding whitespace is valid", verdict.pass === true, `pass=${verdict.pass}`);
	check("exact final PASS is parsed", verdict.unparsed === false, `unparsed=${verdict.unparsed}`);
}

// Complemento: sin veredicto parseable en ninguna parte → FAIL conservador marcado como unparsed.
async function noVerdictIsConservativeFail(mod) {
	const { pi } = makeExecPi({ code: 0, killed: false, stdout: "the judge rambled but never voted", stderr: "" });
	const verdict = await mod.runIndependentVerifier(pi, makeVerifierCtx(), makeVerifierGoal());
	check("no parseable verdict → conservative FAIL", verdict.pass === false, `pass=${verdict.pass}`);
	check("no parseable verdict → unparsed=true", verdict.unparsed === true, `unparsed=${verdict.unparsed}`);
}

// ===========================================================================
// BRECHA 2: rama de criterios de makeIndependentVerifierPrompt; no se indicaron criterios.
// ===========================================================================
async function promptNoCriteriaBranch(mod) {
	const { pi, execCalls } = makeExecPi({ code: 0, killed: false, stdout: "VERDICT: PASS", stderr: "" });
	await mod.runIndependentVerifier(
		pi,
		makeVerifierCtx(),
		makeVerifierGoal({ successCriteria: undefined, derivedCriteria: undefined }),
	);
	const prompt = capturedPrompt(execCalls);
	check(
		"no-criteria prompt contains 'no se indicaron explícitamente'",
		prompt.includes("no se indicaron explícitamente"),
		"missing inference clause",
	);
	check(
		"no-criteria prompt omits the definition-of-done criteria block",
		!prompt.includes("CRITERIOS DE ÉXITO (definición de terminado):"),
		"unexpected definition-of-done block",
	);
}

// Complemento: criterios presentes → bloque definition-of-done con el texto de criterios; sin cláusula de inferencia.
async function promptWithCriteriaBranch(mod) {
	const { pi, execCalls } = makeExecPi({ code: 0, killed: false, stdout: "VERDICT: PASS", stderr: "" });
	await mod.runIndependentVerifier(pi, makeVerifierCtx(), makeVerifierGoal({ successCriteria: "the tests pass" }));
	const prompt = capturedPrompt(execCalls);
	check(
		"with-criteria prompt contains the definition-of-done block",
		prompt.includes("CRITERIOS DE ÉXITO (definición de terminado):"),
		"missing definition-of-done block",
	);
	check("with-criteria prompt embeds the criteria text", prompt.includes("the tests pass"), "missing criteria text");
	check(
		"with-criteria prompt omits the 'none were stated' inference clause",
		!prompt.includes("no se indicaron explícitamente"),
		"unexpected inference clause",
	);
}

// derivedCriteria se usa cuando successCriteria está ausente (fallback de effectiveCriteria).
async function promptUsesDerivedCriteria(mod) {
	const { pi, execCalls } = makeExecPi({ code: 0, killed: false, stdout: "VERDICT: PASS", stderr: "" });
	await mod.runIndependentVerifier(
		pi,
		makeVerifierCtx(),
		makeVerifierGoal({ successCriteria: undefined, derivedCriteria: "lint is clean" }),
	);
	const prompt = capturedPrompt(execCalls);
	check(
		"derivedCriteria fills the definition-of-done when successCriteria is absent",
		prompt.includes("CRITERIOS DE ÉXITO (definición de terminado):") && prompt.includes("lint is clean"),
		"derivedCriteria not used",
	);
}

// ===========================================================================
// BRECHA 3: wiring de exec de runIndependentVerifier; cwd, timeout, signal.
// ===========================================================================
async function execWiring(mod) {
	const goal = makeVerifierGoal({ verifierTimeoutMs: 4242 });
	const ctx = makeVerifierCtx({ cwd: "/tmp/some-workspace" });
	const { pi, execCalls } = makeExecPi({ code: 0, killed: false, stdout: "VERDICT: PASS", stderr: "" });
	await mod.runIndependentVerifier(pi, ctx, goal);
	check("exec called exactly once", execCalls.length === 1, `calls=${execCalls.length}`);
	const opts = execCalls[0].opts;
	check("exec opts.timeout === goal.verifierTimeoutMs", opts.timeout === 4242, `timeout=${opts.timeout}`);
	check("exec opts.cwd === ctx.cwd", opts.cwd === "/tmp/some-workspace", `cwd=${opts.cwd}`);
	check(
		"exec opts.signal === goal.controller.signal",
		opts.signal === goal.controller.signal,
		"signal not threaded from controller",
	);
	// El argv garantiza una corrida de judge read-only y sin sesión.
	const args = execCalls[0].args;
	check(
		"argv requests a one-shot sessionless run (-p --no-session)",
		args.includes("-p") && args.includes("--no-session"),
		JSON.stringify(args.slice(0, 4)),
	);
	check(
		"argv passes the read-only --tools allowlist",
		args.includes("--tools") && args.includes("read,grep,find,ls"),
		JSON.stringify(args),
	);
}

// verifierTools vacío debe DESHABILITAR tools (--no-tools), nunca caer en un default mutante.
async function emptyToolsDisablesTools(mod) {
	const { pi, execCalls } = makeExecPi({ code: 0, killed: false, stdout: "VERDICT: PASS", stderr: "" });
	await mod.runIndependentVerifier(pi, makeVerifierCtx(), makeVerifierGoal({ verifierTools: [] }));
	const args = execCalls[0].args;
	check(
		"empty verifierTools → --no-tools (never a mutating default)",
		args.includes("--no-tools") && !args.includes("--tools"),
		JSON.stringify(args),
	);
}

// ===========================================================================
// Caracterización extra de modos de falla (barata, determinística).
// ===========================================================================
async function killedIsConservativeFail(mod) {
	const { pi } = makeExecPi({ code: 0, killed: true, stdout: "VERDICT: PASS", stderr: "" });
	const verdict = await mod.runIndependentVerifier(pi, makeVerifierCtx(), makeVerifierGoal({ verifierTimeoutMs: 99 }));
	check("killed (timeout) → FAIL even with a PASS line", verdict.pass === false, `pass=${verdict.pass}`);
	check("killed → unparsed=true", verdict.unparsed === true, `unparsed=${verdict.unparsed}`);
	check("killed feedback names the timeout budget", verdict.feedback.includes("99ms"), verdict.feedback);
}

async function nonZeroExitWithPassIsFail(mod) {
	const { pi } = makeExecPi({ code: 1, killed: false, stdout: "VERDICT: PASS", stderr: "" });
	const verdict = await mod.runIndependentVerifier(pi, makeVerifierCtx(), makeVerifierGoal());
	check("non-zero exit + PASS line is contradictory → FAIL", verdict.pass === false, `pass=${verdict.pass}`);
	check(
		"non-zero-exit override is a parsed verdict (unparsed=false)",
		verdict.unparsed === false,
		`unparsed=${verdict.unparsed}`,
	);
}

async function thrownExecIsConservativeFail(mod) {
	const { pi } = makeExecPi(() => {
		throw new Error("boom: spawn failed");
	});
	const verdict = await mod.runIndependentVerifier(pi, makeVerifierCtx(), makeVerifierGoal());
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
		await incidentalPassWithTrailingProseIsUnparsed(mod);
		await multipleVerdictsUseExactFinalLine(mod);
		await exactFinalVerdictIsValid(mod);
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
