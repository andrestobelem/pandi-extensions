/**
 * Durable CHARACTERIZATION suite for extensions/pandi-plan/flags.ts — the small,
 * PURE "pasar con parámetros o setear" surface that plan-approval.test.mjs only
 * exercises indirectly through index.ts handlers.
 *
 * flags.ts only `import type`s from "./prompts.js", so it builds with NO stubs and
 * its exported functions are unit-tested DIRECTLY (the cheapest, most honest level):
 *
 *   1. envFlag(name) — truthy tokens are 1/true/on/yes (case-insensitive, trimmed);
 *      everything else (incl. 0/false/no/empty/unset) is false.
 *   2. resolvePlanFlags({}) — the env layer for PI_PLAN_ULTRACODE / PI_PLAN_ULTRACODE_STEPS /
 *      PI_PLAN_AUTO_SUBMIT when there is no param and no session toggle.
 *   3. getSessionFlagDefault / setSessionFlagDefault — round-trip on the module singleton;
 *      a FRESH module starts unset (undefined).
 *   4. resetSessionFlagDefaults — clears the toggles at a session boundary, so resolvePlanFlags
 *      falls back to env/default again.
 *   5. parsePlanCommandFlags — one-shot /plan flags include --auto-submit.
 *
 * sessionFlagDefaults is module-mutable singleton state. loadModule's cache-busting query gives
 * each scenario a FRESH module instance, so toggle mutations never leak between scenarios.
 *
 * Run it:    node extensions/pandi-plan/tests/integration/flags-coverage.test.mjs
 * Exit code: 0 = all checks passed; 1 = a check failed; 2 = harness crashed.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExtension, createChecker, loadModule } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// extensions/pandi-plan/tests/integration/ -> repo root is four levels up.
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

const { check, counts } = createChecker();

// flags.ts is PURE (only `import type` from ./prompts.js) → no stubs needed.
async function buildFlags() {
	return await buildExtension({
		name: "pi-plan-flags-integration",
		src: path.join(REPO_ROOT, "extensions", "pandi-plan", "flags.ts"),
		outName: "flags.mjs",
		stubs: {},
	});
}

// Run `fn` with process.env[name] set to `value` (or deleted if value===null), restoring after.
function withEnv(name, value, fn) {
	const had = Object.hasOwn(process.env, name);
	const prev = process.env[name];
	try {
		if (value === null) delete process.env[name];
		else process.env[name] = value;
		return fn();
	} finally {
		if (had) process.env[name] = prev;
		else delete process.env[name];
	}
}

// ===========================================================================
// SCENARIO 1: envFlag recognizes the truthy tokens (1/true/on/yes), else false.
// ===========================================================================
async function envFlagTokens(url) {
	const { envFlag } = await loadModule(url);

	// Truthy tokens, including case-insensitivity and surrounding whitespace.
	for (const tok of ["1", "true", "ON", " Yes ", "TRUE", "yes", "on"]) {
		check(`envFlag: "${tok}" → true`, withEnv("PI_PLAN_TEST_FLAG", tok, () => envFlag("PI_PLAN_TEST_FLAG")) === true);
	}
	// Falsy tokens.
	for (const tok of ["0", "false", "no", "", "  ", "yep", "2", "off"]) {
		check(
			`envFlag: "${tok}" → false`,
			withEnv("PI_PLAN_TEST_FLAG", tok, () => envFlag("PI_PLAN_TEST_FLAG")) === false,
		);
	}
	// Unset var → false.
	check(
		"envFlag: unset var → false",
		withEnv("PI_PLAN_TEST_FLAG", null, () => envFlag("PI_PLAN_TEST_FLAG")) === false,
	);
}

// ===========================================================================
// SCENARIO 2: resolvePlanFlags env layer (no param, no session toggle).
// ===========================================================================
async function resolveEnvLayer(url) {
	const { resolvePlanFlags } = await loadModule(url);

	withEnv("PI_PLAN_ULTRACODE", "1", () => {
		withEnv("PI_PLAN_ULTRACODE_STEPS", null, () => {
			withEnv("PI_PLAN_NONINTERACTIVE", null, () => {
				withEnv("PI_PLAN_AUTO_SUBMIT", null, () => {
					const r = resolvePlanFlags({});
					check("resolve(env): PI_PLAN_ULTRACODE=1 → ultracode=true", r.ultracode === true);
					check("resolve(env): no steps env → ultracodeSteps=false", r.ultracodeSteps === false);
					check("resolve(env): no nonInteractive env → nonInteractive=false", r.nonInteractive === false);
					check("resolve(env): no auto-submit env → autoSubmit=false", r.autoSubmit === false);
				});
			});
		});
	});

	withEnv("PI_PLAN_ULTRACODE_STEPS", "on", () => {
		withEnv("PI_PLAN_ULTRACODE", null, () => {
			const r = resolvePlanFlags({});
			check("resolve(env): PI_PLAN_ULTRACODE_STEPS=on → ultracodeSteps=true", r.ultracodeSteps === true);
			check("resolve(env): no ultracode env → ultracode=false", r.ultracode === false);
		});
	});

	withEnv("PI_PLAN_AUTO_SUBMIT", "yes", () => {
		const r = resolvePlanFlags({});
		check("resolve(env): PI_PLAN_AUTO_SUBMIT=yes → autoSubmit=true", r.autoSubmit === true);
	});

	// Explicit param wins over env.
	withEnv("PI_PLAN_ULTRACODE", "1", () => {
		const r = resolvePlanFlags({ ultracode: false });
		check("resolve(param): explicit param false beats env=1", r.ultracode === false);
	});
	withEnv("PI_PLAN_AUTO_SUBMIT", "1", () => {
		const r = resolvePlanFlags({ autoSubmit: false });
		check("resolve(param): explicit autoSubmit=false beats env=1", r.autoSubmit === false);
	});
}

// ===========================================================================
// SCENARIO 3: get/setSessionFlagDefault round-trip; fresh module starts unset.
// ===========================================================================
async function sessionDefaultRoundTrip(url) {
	const { getSessionFlagDefault, setSessionFlagDefault } = await loadModule(url);

	// Fresh module: every session toggle starts unset.
	check("session: fresh ultracode default is undefined", getSessionFlagDefault("ultracode") === undefined);
	check("session: fresh ultracodeSteps default is undefined", getSessionFlagDefault("ultracodeSteps") === undefined);
	check("session: fresh autoSubmit default is undefined", getSessionFlagDefault("autoSubmit") === undefined);

	setSessionFlagDefault("ultracode", true);
	check("session: set ultracode=true round-trips", getSessionFlagDefault("ultracode") === true);
	check("session: unrelated ultracodeSteps still undefined", getSessionFlagDefault("ultracodeSteps") === undefined);
	check("session: unrelated autoSubmit still undefined", getSessionFlagDefault("autoSubmit") === undefined);

	setSessionFlagDefault("autoSubmit", true);
	check("session: set autoSubmit=true round-trips", getSessionFlagDefault("autoSubmit") === true);

	setSessionFlagDefault("ultracode", false);
	check("session: set ultracode=false round-trips", getSessionFlagDefault("ultracode") === false);
}

// ===========================================================================
// SCENARIO 4: resetSessionFlagDefaults clears toggles; resolve falls back to env/default.
// ===========================================================================
async function resetClearsToggles(url) {
	const { getSessionFlagDefault, setSessionFlagDefault, resetSessionFlagDefaults, resolvePlanFlags } =
		await loadModule(url);

	setSessionFlagDefault("ultracode", true);
	setSessionFlagDefault("ultracodeSteps", true);
	setSessionFlagDefault("autoSubmit", true);
	// Session toggle wins over env even when env is unset → resolves true.
	withEnv("PI_PLAN_ULTRACODE", null, () => {
		const r = resolvePlanFlags({});
		check("reset: session toggle applies before reset (ultracode=true)", r.ultracode === true);
		check("reset: session toggle applies before reset (steps=true)", r.ultracodeSteps === true);
		check("reset: session toggle applies before reset (autoSubmit=true)", r.autoSubmit === true);
	});

	resetSessionFlagDefaults();
	check("reset: ultracode cleared to undefined", getSessionFlagDefault("ultracode") === undefined);
	check("reset: ultracodeSteps cleared to undefined", getSessionFlagDefault("ultracodeSteps") === undefined);
	check("reset: autoSubmit cleared to undefined", getSessionFlagDefault("autoSubmit") === undefined);

	// After reset, with env unset, resolve falls back to the default (false).
	withEnv("PI_PLAN_ULTRACODE", null, () => {
		withEnv("PI_PLAN_ULTRACODE_STEPS", null, () => {
			withEnv("PI_PLAN_AUTO_SUBMIT", null, () => {
				const r = resolvePlanFlags({});
				check("reset: resolve falls back to default off (ultracode=false)", r.ultracode === false);
				check("reset: resolve falls back to default off (steps=false)", r.ultracodeSteps === false);
				check("reset: resolve falls back to default off (autoSubmit=false)", r.autoSubmit === false);
			});
		});
	});
	// After reset, env again decides.
	withEnv("PI_PLAN_ULTRACODE", "1", () => {
		const r = resolvePlanFlags({});
		check("reset: resolve falls back to env (ultracode=true)", r.ultracode === true);
	});
	withEnv("PI_PLAN_AUTO_SUBMIT", "1", () => {
		const r = resolvePlanFlags({});
		check("reset: resolve falls back to env (autoSubmit=true)", r.autoSubmit === true);
	});
}

// ===========================================================================
// SCENARIO 5: parsePlanCommandFlags recognizes one-shot auto-submit flags.
// ===========================================================================
async function commandFlagParsing(url) {
	const { parsePlanCommandFlags } = await loadModule(url);
	const parsed = parsePlanCommandFlags("--auto-submit --ultracode build it");
	check("parse flags: --auto-submit sets autoSubmit", parsed.flags.autoSubmit === true);
	check("parse flags: --ultracode still sets ultracode", parsed.flags.ultracode === true);
	check("parse flags: task drops parsed flags", parsed.task === "build it", JSON.stringify(parsed));
}

// ===========================================================================
async function main() {
	const { outDir, url } = await buildFlags();
	try {
		await envFlagTokens(url);
		await resolveEnvLayer(url);
		await sessionDefaultRoundTrip(url);
		await resetClearsToggles(url);
		await commandFlagParsing(url);
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
