/**
 * Contract test for the self-contained notify helpers that drifted across the
 * runtime-local copies in pandi-plan, pandi-goal, pandi-loop, and pandi-dynamic-workflows.
 *
 * The hardened contract is:
 *   - print mode: info goes to stdout; warning/error go to stderr; UI is skipped.
 *   - interactive with UI: delegate to ctx.ui.notify(message, type).
 *   - headless without UI: info stays silent; warning/error go to stderr.
 *
 * Run it:    node extensions/pandi-plan/tests/integration/notify-coverage.test.mjs
 * Exit code: 0 = all checks passed; 1 = a check failed; 2 = harness crashed.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExtension, createChecker, loadModule } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const TARGETS = [
	"extensions/pandi-plan/notify.ts",
	"extensions/pandi-goal/notify.ts",
	"extensions/pandi-loop/notify.ts",
	"extensions/pandi-dynamic-workflows/notify.ts",
];
const PROBLEM_TYPES = ["warning", "error"];
const { check, counts } = createChecker();

async function buildNotify(relPath) {
	const extensionName = path.basename(path.dirname(relPath));
	return await buildExtension({
		name: `notify-coverage-${extensionName}`,
		src: path.join(REPO_ROOT, relPath),
		outName: `${extensionName}-notify.mjs`,
		stubs: {},
	});
}

function makeUiSpy() {
	const calls = [];
	return { calls, notify: (message, type) => calls.push({ message, type }) };
}

async function withCapturedConsole(fn) {
	const out = [];
	const err = [];
	const savedLog = console.log;
	const savedError = console.error;
	console.log = (...args) => out.push(args.join(" "));
	console.error = (...args) => err.push(args.join(" "));
	try {
		await fn();
	} finally {
		console.log = savedLog;
		console.error = savedError;
	}
	return { out, err };
}

function detailFor({ out, err, ui }) {
	return JSON.stringify({ out, err, uiCalls: ui.calls });
}

async function assertPrintInfoGoesToStdout(relPath, notify) {
	const message = `${relPath}: print info`;
	const ui = makeUiSpy();
	const streams = await withCapturedConsole(() => notify({ mode: "print", hasUI: true, ui }, message));
	check(
		`${relPath}: print info writes once to stdout`,
		streams.out.length === 1 && streams.out[0] === message,
		detailFor({ ...streams, ui }),
	);
	check(`${relPath}: print info stays off stderr`, streams.err.length === 0, detailFor({ ...streams, ui }));
	check(`${relPath}: print info skips UI`, ui.calls.length === 0, detailFor({ ...streams, ui }));
}

async function assertPrintProblemGoesToStderr(relPath, notify, type) {
	const message = `${relPath}: print ${type}`;
	const ui = makeUiSpy();
	const streams = await withCapturedConsole(() => notify({ mode: "print", hasUI: true, ui }, message, type));
	check(`${relPath}: print ${type} stays off stdout`, streams.out.length === 0, detailFor({ ...streams, ui }));
	check(
		`${relPath}: print ${type} writes once to stderr`,
		streams.err.length === 1 && streams.err[0] === message,
		detailFor({ ...streams, ui }),
	);
	check(`${relPath}: print ${type} skips UI`, ui.calls.length === 0, detailFor({ ...streams, ui }));
}

async function assertInteractiveDelegates(relPath, notify) {
	const ui = makeUiSpy();
	const message = `${relPath}: interactive warning`;
	const streams = await withCapturedConsole(() => notify({ mode: "tui", hasUI: true, ui }, message, "warning"));
	check(`${relPath}: interactive warning stays off stdout`, streams.out.length === 0, detailFor({ ...streams, ui }));
	check(`${relPath}: interactive warning stays off stderr`, streams.err.length === 0, detailFor({ ...streams, ui }));
	check(
		`${relPath}: interactive warning delegates to UI`,
		ui.calls.length === 1 && ui.calls[0]?.message === message && ui.calls[0]?.type === "warning",
		detailFor({ ...streams, ui }),
	);
}

async function assertInteractiveDefaultsToInfo(relPath, notify) {
	const ui = makeUiSpy();
	notify({ mode: "tui", hasUI: true, ui }, `${relPath}: interactive default`);
	check(
		`${relPath}: interactive default type is info`,
		ui.calls.length === 1 && ui.calls[0]?.type === "info",
		JSON.stringify({ uiCalls: ui.calls }),
	);
}

async function assertHeadlessInfoIsSilent(relPath, notify) {
	const streams = await withCapturedConsole(() => notify({ mode: "tui", hasUI: false }, `${relPath}: headless info`));
	check(
		`${relPath}: headless info stays silent`,
		streams.out.length === 0 && streams.err.length === 0,
		JSON.stringify(streams),
	);
}

async function assertHeadlessProblemGoesToStderr(relPath, notify, type) {
	const message = `${relPath}: headless ${type}`;
	const streams = await withCapturedConsole(() => notify({ mode: "tui", hasUI: false }, message, type));
	check(`${relPath}: headless ${type} stays off stdout`, streams.out.length === 0, JSON.stringify(streams));
	check(
		`${relPath}: headless ${type} writes once to stderr`,
		streams.err.length === 1 && streams.err[0] === message,
		JSON.stringify(streams),
	);
}

async function assertNotifyContract(relPath) {
	const { outDir, url } = await buildNotify(relPath);
	try {
		const { notify } = await loadModule(url);
		check(`${relPath}: notify is an exported function`, typeof notify === "function");
		await assertPrintInfoGoesToStdout(relPath, notify);
		for (const type of PROBLEM_TYPES) await assertPrintProblemGoesToStderr(relPath, notify, type);
		await assertInteractiveDelegates(relPath, notify);
		await assertInteractiveDefaultsToInfo(relPath, notify);
		await assertHeadlessInfoIsSilent(relPath, notify);
		for (const type of PROBLEM_TYPES) await assertHeadlessProblemGoesToStderr(relPath, notify, type);
	} finally {
		await fs.rm(outDir, { recursive: true, force: true }).catch(() => {});
	}
}

async function main() {
	for (const relPath of TARGETS) await assertNotifyContract(relPath);
	console.log("");
	console.log(`TOTAL: ${counts.passed} passed, ${counts.failed} failed`);
	if (counts.failed > 0) {
		console.log("FAILURES:");
		for (const failure of counts.failures) console.log(`  - ${failure}`);
		process.exit(1);
	}
	process.exit(0);
}

main().catch((err) => {
	console.error("INTEGRATION TEST CRASH:", err?.stack ? err.stack : err);
	process.exit(2);
});
