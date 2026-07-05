/**
 * Test de integración de caracterización para extensions/pandi-goal/verifier.ts (el cluster P1
 * del verificador adversarial independiente).
 *
 * Por qué existe este archivo
 * --------------------
 * `npm test` solo hace TYPECHECK; no prueba nada sobre comportamiento runtime. verifier.ts
 * posee tres contratos críticos que una regresión silenciosa podría romper sin ruido:
 *
 *   1. El parse CONSERVATIVE de parseVerdict: ancla en la última línea no vacía, y solo
 *      cuando esa línea no trae veredicto cae a un escaneo de todo el texto donde gana el
 *      ÚLTIMO match `VERDICT:`. Este fallback evita cerrar un goal con un judge malformado;
 *      fijar "last match wins" fija el contrato.
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
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExtension, createChecker, loadModule, sdkStub } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// extensions/pandi-goal/tests/integration/ -> la raíz del repo está cuatro niveles arriba.
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

const { check, counts } = createChecker();

// verifier.ts solo hace `import type` del SDK; sus imports runtime (constants.js, prompts.js,
// types.js) son hojas puras sin deps de módulos externos, así que se empaqueta SIN stubs.
async function buildVerifier() {
	return await buildExtension({
		name: "pi-goal-verifier-coverage",
		src: path.join(REPO_ROOT, "extensions", "pandi-goal", "verifier.ts"),
		outName: "verifier.mjs",
		// verifier.ts trae constants.ts, que importa getPackageDir desde el SDK.
		stubs: { sdk: (dir) => sdkStub(dir) },
	});
}

// Un ActiveGoal mínimamente completo (solo los campos que lee el verifier).
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

// Mock de pi.exec: registra cada llamada ({cmd,args,opts}) y devuelve un resultado provisto por quien llama.
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

// El prompt siempre es el ÚLTIMO elemento de argv que agrega buildVerifierArgs.
function capturedPrompt(calls) {
	const args = calls[0].args;
	return args[args.length - 1];
}

// ===========================================================================
// BRECHA 1: fallback de parseVerdict con texto completo; la última línea no vacía NO tiene
// veredicto, así que corre el escaneo de todo el texto y gana el ÚLTIMO match `VERDICT:`
// (acá PASS, después de un FAIL anterior).
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
	check(
		"fallback PASS is a parsed verdict (unparsed=false)",
		verdict.unparsed === false,
		`unparsed=${verdict.unparsed}`,
	);
}

// Complemento: cuando la línea FINAL no vacía SÍ trae un veredicto, esa línea gana sobre
// cualquier match previo (ancla primero en la última línea no vacía). También fija la ruta sin fallback.
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

// Complemento: sin veredicto parseable en ninguna parte → FAIL conservador marcado como unparsed.
async function noVerdictIsConservativeFail(mod) {
	const { pi } = makePi({ code: 0, killed: false, stdout: "the judge rambled but never voted", stderr: "" });
	const verdict = await mod.runIndependentVerifier(pi, makeCtx(), makeGoal());
	check("no parseable verdict → conservative FAIL", verdict.pass === false, `pass=${verdict.pass}`);
	check("no parseable verdict → unparsed=true", verdict.unparsed === true, `unparsed=${verdict.unparsed}`);
}

// ===========================================================================
// BRECHA 2: rama de criterios de makeIndependentVerifierPrompt; no se indicaron criterios.
// ===========================================================================
async function promptNoCriteriaBranch(mod) {
	const { pi, calls } = makePi({ code: 0, killed: false, stdout: "VERDICT: PASS", stderr: "" });
	await mod.runIndependentVerifier(
		pi,
		makeCtx(),
		makeGoal({ successCriteria: undefined, derivedCriteria: undefined }),
	);
	const prompt = capturedPrompt(calls);
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
	const { pi, calls } = makePi({ code: 0, killed: false, stdout: "VERDICT: PASS", stderr: "" });
	await mod.runIndependentVerifier(pi, makeCtx(), makeGoal({ successCriteria: "the tests pass" }));
	const prompt = capturedPrompt(calls);
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
	const { pi, calls } = makePi({ code: 0, killed: false, stdout: "VERDICT: PASS", stderr: "" });
	await mod.runIndependentVerifier(
		pi,
		makeCtx(),
		makeGoal({ successCriteria: undefined, derivedCriteria: "lint is clean" }),
	);
	const prompt = capturedPrompt(calls);
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
	// El argv garantiza una corrida de judge read-only y sin sesión.
	const args = calls[0].args;
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
	const { pi, calls } = makePi({ code: 0, killed: false, stdout: "VERDICT: PASS", stderr: "" });
	await mod.runIndependentVerifier(pi, makeCtx(), makeGoal({ verifierTools: [] }));
	const args = calls[0].args;
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
	check(
		"non-zero-exit override is a parsed verdict (unparsed=false)",
		verdict.unparsed === false,
		`unparsed=${verdict.unparsed}`,
	);
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
