/**
 * Behavioral integration test for the ULTRACODE posture of extensions/pandi-goal/index.ts.
 *
 * `npm test` is a TYPECHECK only; it proves nothing about runtime behavior. This file pins
 * the observable contract of the `--ultracode` posture flag added to `/goal`:
 *   - `/goal --ultracode <obj>` makes the re-injected ITERATION prompt carry the ULTRACODE
 *     guidance (lean on dynamic workflows), while a plain `/goal <obj>` does NOT.
 *   - the flag is stripped from the objective text (and from the success-criteria split),
 *     so it never leaks into the objective the model sees.
 *   - the posture is persisted on the goal-state snapshot so it survives a reload.
 *
 * Mechanism: the goal extension injects each iteration prompt via `pi.sendUserMessage`. We
 * build the CURRENT index.ts to ESM (same self-bootstrapping pattern as goal-verifier.test.mjs),
 * drive the REAL `/goal` command against a mocked pi/ctx, and capture sendUserMessage + the
 * persisted goal-state snapshots. We assert the OBSERVABLE prompt text and snapshot, not a
 * copy of the wording — if the posture wiring regresses, this suite goes red.
 *
 * Run it:
 *   node extensions/pandi-goal/tests/integration/goal-ultracode.test.mjs
 *
 * Exit code 0 = all checks passed; 1 = a behavioral check failed; 2 = harness crashed.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExtension, createChecker, loadDefault, sdkStub } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

const { check, counts } = createChecker();

async function buildGoal() {
	return await buildExtension({
		name: "pi-goal-ultracode",
		src: path.join(REPO_ROOT, "extensions", "pandi-goal", "index.ts"),
		outName: "goal.mjs",
		stubs: { typebox: true, sdk: (dir) => sdkStub(dir) },
	});
}

// Mock pi: capture the prompts injected via sendUserMessage and every persisted goal-state.
function makePi() {
	const tools = new Map();
	const commands = new Map();
	const messages = []; // every injected iteration/verification prompt, in order
	const states = []; // every appended goal-state snapshot, in order
	const pi = {
		registerTool: (def) => tools.set(def.name, def),
		registerCommand: (name, opts) => commands.set(name, opts),
		on: () => {},
		appendEntry: (customType, data) => {
			if (customType === "goal-state") states.push(data);
		},
		sendUserMessage: (text) => messages.push(text),
		exec: async () => ({ code: 0, killed: false, stdout: "", stderr: "" }),
	};
	return { pi, tools, commands, messages, states };
}

function makeCtx() {
	return {
		mode: "tui",
		hasUI: true,
		cwd: REPO_ROOT,
		isIdle: () => true,
		isProjectTrusted: () => false,
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

function lastSnapshot(states) {
	return states.length ? states[states.length - 1] : undefined;
}

// The first injected message is the iteration-1 prompt (fireGoal runs at start).
async function startGoalAndCapture(goalUrl, args) {
	const goalExtension = await loadDefault(goalUrl);
	const ctx = makeCtx();
	const built = makePi();
	goalExtension(built.pi);
	built.commands.get("goal").handler(args, ctx);
	return built;
}

// ===========================================================================
// SCENARIO 1: `--ultracode` injects the ULTRACODE guidance into the iteration prompt.
// ===========================================================================
async function ultracodeInjectsGuidance(goalUrl) {
	const { messages, states } = await startGoalAndCapture(goalUrl, "--ultracode ship the dashboard");
	const prompt = messages[0] ?? "";
	check("ultracode: an iteration prompt was injected", messages.length >= 1, `messages=${messages.length}`);
	check("ultracode: iteration prompt carries ULTRACODE guidance", /ULTRACODE:/.test(prompt));
	check("ultracode: guidance mentions dynamic workflows", /dynamic workflows/i.test(prompt));
	check(
		"ultracode: flag is stripped from the objective",
		/OBJECTIVE \(verbatim\):\s*\nship the dashboard/.test(prompt) && !/--ultracode/.test(prompt),
		prompt.slice(0, 200),
	);
	check("ultracode: posture is persisted on the snapshot", lastSnapshot(states)?.ultracode === true);
}

// ===========================================================================
// SCENARIO 2: alias `--uc` works the same way.
// ===========================================================================
async function ucAliasWorks(goalUrl) {
	const { messages, states } = await startGoalAndCapture(goalUrl, "--uc refactor the parser");
	const prompt = messages[0] ?? "";
	check("alias --uc: iteration prompt carries ULTRACODE guidance", /ULTRACODE:/.test(prompt));
	check("alias --uc: posture is persisted", lastSnapshot(states)?.ultracode === true);
}

// ===========================================================================
// SCENARIO 3: no flag → no ultracode wording, posture is off (characterizes the default).
// ===========================================================================
async function defaultHasNoUltracode(goalUrl) {
	const { messages, states } = await startGoalAndCapture(goalUrl, "ship the dashboard");
	const prompt = messages[0] ?? "";
	check("default: an iteration prompt was injected", messages.length >= 1);
	check("default: no ULTRACODE wording without the flag", !/ULTRACODE:/.test(prompt));
	check(
		"default: posture is off (undefined/false) on the snapshot",
		!lastSnapshot(states)?.ultracode,
		`ultracode=${lastSnapshot(states)?.ultracode}`,
	);
}

// ===========================================================================
// SCENARIO 4: the flag is stripped even when combined with `-- <criteria>`; both the
// objective and the criteria survive intact.
// ===========================================================================
async function flagStrippedAlongsideCriteria(goalUrl) {
	const { messages, states } = await startGoalAndCapture(
		goalUrl,
		"ship the dashboard --ultracode -- the integration suite is green",
	);
	const prompt = messages[0] ?? "";
	check("criteria+flag: ULTRACODE guidance present", /ULTRACODE:/.test(prompt));
	check(
		"criteria+flag: objective is clean (no flag token)",
		/OBJECTIVE \(verbatim\):\s*\nship the dashboard/.test(prompt) && !/--ultracode/.test(prompt),
	);
	check(
		"criteria+flag: success criteria survive",
		/the integration suite is green/.test(prompt) &&
			lastSnapshot(states)?.successCriteria === "the integration suite is green",
	);
}

async function main() {
	const { outDir, url } = await buildGoal();
	try {
		await ultracodeInjectsGuidance(url);
		await ucAliasWorks(url);
		await defaultHasNoUltracode(url);
		await flagStrippedAlongsideCriteria(url);
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
