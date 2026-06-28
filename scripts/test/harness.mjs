/**
 * Shared scaffolding for the durable integration suites under
 * extensions/<ext>/tests/integration/*.test.mjs.
 *
 * Every suite hand-rolled the same tiny assertion reporter (let passed/failed +
 * a `check(label, cond, detail)` that logs PASS/FAIL). That block was byte-
 * identical across 24/26 suites; it now lives here once. The per-suite SUMMARY
 * (header text, exit codes, cleanup) stays in each file because it genuinely
 * varies, so this module only owns the counters + the check() logic.
 *
 * Not published (scripts/ is outside package.json "files"); a dev/test concern,
 * imported from a suite via "../../../../scripts/test/harness.mjs" (suites all
 * sit at extensions/<ext>/tests/integration/, four levels below the repo root).
 *
 * Usage:
 *   import { createChecker } from "../../../../scripts/test/harness.mjs";
 *   const { check, counts } = createChecker();
 *   check("does the thing", actual === expected, `got ${actual}`);
 *   // ...later, in the suite's own summary:
 *   console.log(`${counts.passed} passed, ${counts.failed} failed`);
 *   if (counts.failed) { console.error(counts.failures.join("\n")); process.exit(1); }
 */

/**
 * Create an isolated PASS/FAIL reporter. Returns the `check` function plus a live
 * `counts` object ({ passed, failed, failures }) the suite reads in its summary.
 * Logging is byte-identical to the inline reporter it replaces.
 */
export function createChecker() {
	const counts = { passed: 0, failed: 0, failures: [] };
	function check(label, cond, detail) {
		if (cond) {
			counts.passed += 1;
			console.log(`PASS: ${label}`);
		} else {
			counts.failed += 1;
			counts.failures.push(label + (detail ? `  [${detail}]` : ""));
			console.log(`FAIL: ${label}${detail ? `  [${detail}]` : ""}`);
		}
	}
	return { check, counts };
}
