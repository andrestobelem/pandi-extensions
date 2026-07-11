/**
 * Test de integración de comportamiento para la postura ULTRACODE de extensions/pandi-goal/index.ts.
 *
 * Ejecución:
 *   node extensions/pandi-goal/tests/integration/goal-ultracode.test.mjs
 */

import * as fs from "node:fs/promises";
import { createChecker, loadDefault } from "../../../shared/test/harness.mjs";
import { buildGoal, lastGoalSnapshot, makeCtx, makePi } from "./goal-test-support.mjs";

const { check, counts } = createChecker();

async function startGoalAndCapture(goalUrl, args) {
	const goalExtension = await loadDefault(goalUrl);
	const ctx = makeCtx();
	const built = makePi(undefined, { trackMessages: true, captureHandlers: false });
	goalExtension(built.pi);
	built.commands.get("goal").handler(args, ctx);
	return built;
}

async function ultracodeInjectsGuidance(goalUrl) {
	const { messages, states } = await startGoalAndCapture(goalUrl, "--ultracode ship the dashboard");
	const prompt = messages[0] ?? "";
	check("ultracode: an iteration prompt was injected", messages.length >= 1, `messages=${messages.length}`);
	check("ultracode: iteration prompt carries ULTRACODE guidance", /ULTRACODE:/.test(prompt));
	check("ultracode: guidance mentions dynamic workflows", /dynamic workflows/i.test(prompt));
	check(
		"ultracode: flag is stripped from the objective",
		/OBJETIVO \(textual\):\s*\nship the dashboard/.test(prompt) && !/--ultracode/.test(prompt),
		prompt.slice(0, 200),
	);
	check("ultracode: posture is persisted on the snapshot", lastGoalSnapshot(states)?.ultracode === true);
}

async function ucAliasWorks(goalUrl) {
	const { messages, states } = await startGoalAndCapture(goalUrl, "--uc refactor the parser");
	const prompt = messages[0] ?? "";
	check("alias --uc: iteration prompt carries ULTRACODE guidance", /ULTRACODE:/.test(prompt));
	check("alias --uc: posture is persisted", lastGoalSnapshot(states)?.ultracode === true);
}

async function defaultHasNoUltracode(goalUrl) {
	const { messages, states } = await startGoalAndCapture(goalUrl, "ship the dashboard");
	const prompt = messages[0] ?? "";
	check("default: an iteration prompt was injected", messages.length >= 1);
	check("default: no ULTRACODE wording without the flag", !/ULTRACODE:/.test(prompt));
	check(
		"default: posture is off (undefined/false) on the snapshot",
		!lastGoalSnapshot(states)?.ultracode,
		`ultracode=${lastGoalSnapshot(states)?.ultracode}`,
	);
}

async function flagStrippedAlongsideCriteria(goalUrl) {
	const { messages, states } = await startGoalAndCapture(
		goalUrl,
		"ship the dashboard --ultracode -- the integration suite is green",
	);
	const prompt = messages[0] ?? "";
	check("criteria+flag: ULTRACODE guidance present", /ULTRACODE:/.test(prompt));
	check(
		"criteria+flag: objective is clean (no flag token)",
		/OBJETIVO \(textual\):\s*\nship the dashboard/.test(prompt) && !/--ultracode/.test(prompt),
	);
	check(
		"criteria+flag: success criteria survive",
		/the integration suite is green/.test(prompt) &&
			lastGoalSnapshot(states)?.successCriteria === "the integration suite is green",
	);
}

async function main() {
	const { outDir, url } = await buildGoal({ name: "pi-goal-ultracode" });
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
