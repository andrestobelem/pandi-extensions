/**
 * Characterization tests for the self-contained user-notification helper in
 * extensions/pi-plan/notify.ts.
 *
 * notify.ts is a PURE module (only `export type`/`export interface` plus a single
 * exported function `notify`); it imports nothing at runtime and touches only
 * `console.log` and the structural `ctx.ui.notify`. So it builds with NO stubs and
 * we unit-test the EXPORTED function directly, asserting its CURRENT real behavior:
 *
 *   - print mode → writes the message to stdout (console.log) ONCE and returns
 *     early, skipping the UI entirely (even when hasUI/ui are present).
 *   - interactive (non-print) with hasUI+ui → delegates to ctx.ui.notify(message, type),
 *     passing the type through; the default type is "info".
 *   - interactive WITHOUT ui (or hasUI=false) → a silent no-op (the truthiness guard).
 *
 * Run it:    node extensions/pi-plan/tests/integration/notify-coverage.test.mjs
 * Exit code: 0 = all checks passed; 1 = a check failed; 2 = harness crashed.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExtension, createChecker, loadModule } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// extensions/pi-plan/tests/integration/ -> repo root is four levels up.
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

const { check, counts } = createChecker();

// notify.ts is pure (only `import type`); build with NO stubs.
async function buildNotify() {
	return await buildExtension({
		name: "pi-plan-notify-coverage",
		src: path.join(REPO_ROOT, "extensions", "pi-plan", "notify.ts"),
		outName: "notify.mjs",
		stubs: {},
	});
}

// A tiny ui.notify spy that records its calls.
function makeUiSpy() {
	const calls = [];
	return { calls, notify: (message, type) => calls.push({ message, type }) };
}

// Capture console.log for the duration of `fn`, restoring it afterwards.
async function captureLog(fn) {
	const logged = [];
	const orig = console.log;
	console.log = (...a) => logged.push(a);
	try {
		await fn();
	} finally {
		console.log = orig;
	}
	return logged;
}

// ===========================================================================
// SCENARIO 1: print mode routes the message to stdout, returns early, skips UI.
// ===========================================================================
async function printModeRoutesToStdout(notify) {
	const ui = makeUiSpy();
	const ctx = { mode: "print", hasUI: true, ui };
	let r;
	const logged = await captureLog(() => {
		r = notify(ctx, "hello", "warning");
	});
	check("print: returns undefined (no value)", r === undefined);
	check("print: console.log called exactly once", logged.length === 1);
	check("print: console.log called with the message", logged[0] && logged[0].length === 1 && logged[0][0] === "hello");
	check("print: ui.notify NOT called (UI skipped)", ui.calls.length === 0);
}

// print mode skips the UI even when type is omitted (still stdout-only).
async function printModeIgnoresType(notify) {
	const ui = makeUiSpy();
	const ctx = { mode: "print", hasUI: true, ui };
	const logged = await captureLog(() => notify(ctx, "msg"));
	check("print(no type): console.log called once with the message", logged.length === 1 && logged[0][0] === "msg");
	check("print(no type): ui.notify still NOT called", ui.calls.length === 0);
}

// ===========================================================================
// SCENARIO 2: interactive with UI delegates to ctx.ui.notify, passing the type.
// ===========================================================================
async function interactiveDelegatesToUi(notify) {
	const ui = makeUiSpy();
	const ctx = { mode: "tui", hasUI: true, ui };
	const logged = await captureLog(() => notify(ctx, "saved", "error"));
	check("interactive: console.log NOT called", logged.length === 0);
	check("interactive: ui.notify called exactly once", ui.calls.length === 1);
	check("interactive: ui.notify got the message", ui.calls[0]?.message === "saved");
	check("interactive: ui.notify got the explicit type", ui.calls[0]?.type === "error");
}

// Default type is "info" when omitted.
async function interactiveDefaultsToInfo(notify) {
	const ui = makeUiSpy();
	const ctx = { mode: "tui", hasUI: true, ui };
	notify(ctx, "plain");
	check("default-type: ui.notify called once", ui.calls.length === 1);
	check('default-type: type defaults to "info"', ui.calls[0]?.type === "info");
}

// ===========================================================================
// SCENARIO 3: no-op paths — no UI delivery, no stdout.
// ===========================================================================
async function noUiIsNoOp(notify) {
	// hasUI=false (with a ui present) → guard short-circuits, nothing happens.
	const ui = makeUiSpy();
	const ctx = { mode: "tui", hasUI: false, ui };
	const logged = await captureLog(() => notify(ctx, "ignored", "warning"));
	check("hasUI=false: ui.notify NOT called", ui.calls.length === 0);
	check("hasUI=false: console.log NOT called", logged.length === 0);
}

async function hasUiButNoUiObjectIsNoOp(notify) {
	// hasUI=true but ui undefined → the `ctx.ui` truthiness guard makes it a no-op (no crash).
	const ctx = { mode: "tui", hasUI: true };
	let r;
	const logged = await captureLog(() => {
		r = notify(ctx, "no ui object");
	});
	check("hasUI+no-ui: returns undefined", r === undefined);
	check("hasUI+no-ui: console.log NOT called", logged.length === 0);
}

async function main() {
	const { outDir, url } = await buildNotify();
	try {
		const { notify } = await loadModule(url);
		check("notify is an exported function", typeof notify === "function");
		await printModeRoutesToStdout(notify);
		await printModeIgnoresType(notify);
		await interactiveDelegatesToUi(notify);
		await interactiveDefaultsToInfo(notify);
		await noUiIsNoOp(notify);
		await hasUiButNoUiObjectIsNoOp(notify);
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
