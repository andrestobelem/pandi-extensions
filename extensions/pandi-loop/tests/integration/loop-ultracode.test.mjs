/**
 * Behavioral integration test for the ULTRACODE posture of extensions/pandi-loop/index.ts.
 *
 * `npm test` is a TYPECHECK only; it proves nothing about runtime behavior. This file pins
 * the observable contract of the `--ultracode` posture flag added to `/loop`:
 *   - `/loop --ultracode <task>` makes the re-injected ITERATION prompt carry the ULTRACODE
 *     guidance (lean on dynamic workflows), while a plain `/loop <task>` does NOT.
 *   - the flag is stripped from the task text and never mistaken for the trailing interval
 *     token (`--ultracode <task> 5m` keeps fixed cadence AND the posture).
 *   - the posture is persisted on the loop-state snapshot so it survives a reload.
 *
 * Mechanism: pi-loop injects each iteration prompt via `pi.sendUserMessage`. We build the
 * CURRENT index.ts to ESM (same self-bootstrapping pattern as loop-behavior.test.mjs), drive
 * the REAL `/loop` command against a mocked pi/ctx, and capture sendUserMessage + the
 * persisted loop-state snapshots. We assert the OBSERVABLE prompt text and snapshot.
 *
 * Run it:
 *   node extensions/pandi-loop/tests/integration/loop-ultracode.test.mjs
 *
 * Exit code 0 = all checks passed; 1 = a behavioral check failed; 2 = harness crashed.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExtension, createChecker, loadDefault, sdkStub } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const TEST_PROJECT_ROOT = path.join(REPO_ROOT, ".pi", "tmp", "loop-ultracode-test");
let TEST_CTX_SEQ = 0;

const { check, counts } = createChecker();

async function buildLoop() {
	return await buildExtension({
		name: "pi-loop-ultracode",
		src: path.join(REPO_ROOT, "extensions", "pandi-loop", "index.ts"),
		outName: "loop.mjs",
		stubs: { typebox: true, sdk: (dir) => sdkStub(dir) },
	});
}

function makePi() {
	const tools = new Map();
	const commands = new Map();
	const entries = [];
	const sentMessages = [];
	const pi = {
		registerTool: (def) => tools.set(def.name, def),
		registerCommand: (name, opts) => commands.set(name, opts),
		on: () => {},
		appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
		sendUserMessage: (content) => sentMessages.push(content),
		exec: async () => ({ code: 0, stdout: "", stderr: "", killed: false }),
	};
	return { pi, tools, commands, entries, sentMessages };
}

function makeCtx() {
	const projectCwd = path.join(TEST_PROJECT_ROOT, `ctx-${++TEST_CTX_SEQ}`);
	return {
		mode: "tui",
		hasUI: true,
		cwd: projectCwd,
		isIdle: () => true,
		isProjectTrusted: () => true,
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

function latestSnapshot(entries) {
	let snap;
	for (const e of entries) {
		if (e.customType === "loop-state" && e.data) snap = e.data;
	}
	return snap;
}

// Start a loop and capture the first injected iteration prompt (fireWake runs synchronously).
async function startLoopAndCapture(loopUrl, args) {
	const loopExtension = await loadDefault(loopUrl);
	const ctx = makeCtx();
	const built = makePi();
	loopExtension(built.pi);
	await built.commands.get("loop").handler(args, ctx);
	return built;
}

// ===========================================================================
// SCENARIO 1: `--ultracode` injects the ULTRACODE guidance into the iteration prompt.
// ===========================================================================
async function ultracodeInjectsGuidance(loopUrl) {
	const { sentMessages, entries } = await startLoopAndCapture(loopUrl, "--ultracode watch the build");
	const prompt = sentMessages[0] ?? "";
	check("ultracode: an iteration prompt was injected", sentMessages.length >= 1, `messages=${sentMessages.length}`);
	check("ultracode: iteration prompt carries ULTRACODE guidance", /ULTRACODE:/.test(prompt));
	check("ultracode: guidance mentions dynamic workflows", /dynamic workflows/i.test(prompt));
	check(
		"ultracode: flag stripped from the task",
		/TASK \(verbatim\):\s*\nwatch the build/.test(prompt) && !/--ultracode/.test(prompt),
		prompt.slice(0, 200),
	);
	check("ultracode: posture is persisted on the snapshot", latestSnapshot(entries)?.ultracode === true);
}

// ===========================================================================
// SCENARIO 2: the flag is not mistaken for the trailing interval; fixed cadence survives.
// ===========================================================================
async function flagDoesNotEatInterval(loopUrl) {
	const { sentMessages, entries } = await startLoopAndCapture(loopUrl, "--ultracode watch the build 5m");
	const prompt = sentMessages[0] ?? "";
	const snap = latestSnapshot(entries);
	check("interval+flag: ULTRACODE guidance present", /ULTRACODE:/.test(prompt));
	check("interval+flag: posture persisted", snap?.ultracode === true);
	check("interval+flag: fixed mode preserved", snap?.mode === "fixed", `mode=${snap?.mode}`);
	check("interval+flag: interval is 5m (300000ms)", snap?.intervalMs === 300000, `intervalMs=${snap?.intervalMs}`);
	check("interval+flag: task is clean", snap?.task === "watch the build", `task=${snap?.task}`);
}

// ===========================================================================
// SCENARIO 3: no flag → no ultracode wording, posture off (characterizes the default).
// ===========================================================================
async function defaultHasNoUltracode(loopUrl) {
	const { sentMessages, entries } = await startLoopAndCapture(loopUrl, "watch the build");
	const prompt = sentMessages[0] ?? "";
	check("default: an iteration prompt was injected", sentMessages.length >= 1);
	check("default: no ULTRACODE wording without the flag", !/ULTRACODE:/.test(prompt));
	check(
		"default: posture is off on the snapshot",
		!latestSnapshot(entries)?.ultracode,
		`ultracode=${latestSnapshot(entries)?.ultracode}`,
	);
}

async function main() {
	const { outDir, url } = await buildLoop();
	try {
		await ultracodeInjectsGuidance(url);
		await flagDoesNotEatInterval(url);
		await defaultHasNoUltracode(url);
	} finally {
		await fs.rm(outDir, { recursive: true, force: true }).catch(() => {});
		await fs.rm(TEST_PROJECT_ROOT, { recursive: true, force: true }).catch(() => {});
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
