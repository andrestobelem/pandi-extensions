#!/usr/bin/env node
/**
 * Unit tests for the PURE helpers in pi-goal that the coverage audit flagged as untested:
 *   - prompts.ts:       effectiveCriteria, formatProgressLog (last-N bound),
 *                       makeGoalIterationPrompt (criteria-present vs "none were provided"),
 *                       makeGoalVerificationPrompt (adversarial completeness check).
 *   - session-state.ts: collectLatestByKey (type/customType filter, falsy-data skip,
 *                       non-string-key skip, last-write-wins).
 *   - time.ts:          formatEta (null → "now", past clamps to "0s", s vs m formatting).
 *
 * All three are pure (no SDK/runtime imports beyond bundled constants), so they are tested
 * by bundling each module standalone and importing its named exports.
 *
 * Run it:
 *   node extensions/pi-goal/tests/integration/goal-helpers.test.mjs
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExtension, createChecker, loadModule } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

const { check, counts } = createChecker();

const PROGRESS_LOG_KEEP = 12; // mirrors extensions/pi-goal/constants.ts (pinned here on purpose)

function baseGoal(over = {}) {
	return {
		goalId: "g1",
		objective: "Make the build green",
		successCriteria: undefined,
		derivedCriteria: undefined,
		assessments: [],
		iteration: 1,
		maxIterations: 8,
		lastReason: undefined,
		ultracode: false,
		...over,
	};
}

async function scenarioPrompts(url) {
	const { effectiveCriteria, formatProgressLog, makeGoalIterationPrompt, makeGoalVerificationPrompt } =
		await loadModule(url);

	// effectiveCriteria: user criteria win; else derived; else undefined; whitespace trimmed.
	check(
		"effectiveCriteria prefers successCriteria",
		effectiveCriteria(baseGoal({ successCriteria: "  ship it  ", derivedCriteria: "x" })) === "ship it",
	);
	check(
		"effectiveCriteria falls back to derivedCriteria",
		effectiveCriteria(baseGoal({ successCriteria: "   ", derivedCriteria: " done when tests pass " })) ===
			"done when tests pass",
	);
	check("effectiveCriteria undefined when neither", effectiveCriteria(baseGoal()) === undefined);

	// formatProgressLog: empty → []; otherwise header + bounded last-N lines, oldest dropped.
	check("formatProgressLog empty assessments → []", formatProgressLog(baseGoal()).length === 0);
	const many = Array.from({ length: PROGRESS_LOG_KEEP + 5 }, (_, i) => ({
		iteration: i + 1,
		status: "continue",
		assessment: `step ${i + 1}`,
		nextStep: `do ${i + 1}`,
	}));
	const log = formatProgressLog(baseGoal({ assessments: many }));
	check(
		"formatProgressLog has header + exactly PROGRESS_LOG_KEEP lines",
		log.length === PROGRESS_LOG_KEEP + 1 && log[0] === "PROGRESS LOG (most recent last):",
	);
	check(
		"formatProgressLog keeps the most recent (last) assessment",
		log[log.length - 1].includes(`it ${PROGRESS_LOG_KEEP + 5}`),
	);
	check("formatProgressLog drops the oldest assessment", !log.some((l) => l.includes("it 1 ")));
	check(
		"formatProgressLog omits 'next:' when nextStep is absent",
		formatProgressLog(baseGoal({ assessments: [{ iteration: 1, status: "done", assessment: "ok" }] }))[1] ===
			"- it 1 [done] ok",
	);

	// makeGoalIterationPrompt: criteria-present vs absent branch.
	const withCriteria = makeGoalIterationPrompt(baseGoal({ successCriteria: "all tests pass" }));
	check("iteration prompt includes objective verbatim", withCriteria.includes("Make the build green"));
	check(
		"iteration prompt shows definition-of-done when criteria present",
		withCriteria.includes("SUCCESS CRITERIA (definition-of-done):") && withCriteria.includes("all tests pass"),
	);
	const noCriteria = makeGoalIterationPrompt(baseGoal());
	check(
		"iteration prompt 'none were provided' when no criteria",
		noCriteria.includes("SUCCESS CRITERIA: none were provided."),
	);
	check(
		"iteration prompt asks to derive 2-5 criteria",
		/derive 2-5 concrete, VERIFIABLE success criteria/.test(noCriteria),
	);
	check("iteration prompt shows iteration N/max", noCriteria.includes("This is iteration 1/8."));
	check("iteration prompt omits ULTRACODE by default", !noCriteria.includes("ULTRACODE:"));
	check(
		"iteration prompt includes ULTRACODE when enabled",
		makeGoalIterationPrompt(baseGoal({ ultracode: true })).includes("ULTRACODE:"),
	);
	check(
		"iteration prompt includes previous decision when set",
		makeGoalIterationPrompt(baseGoal({ lastReason: "waiting on CI" })).includes("Previous decision: waiting on CI"),
	);

	// makeGoalVerificationPrompt: adversarial completeness check.
	const verify = makeGoalVerificationPrompt(baseGoal({ successCriteria: "tests pass" }));
	check("verification prompt has COMPLETENESS CHECK header", verify.includes("COMPLETENESS CHECK for /goal g1."));
	check("verification prompt includes objective verbatim", verify.includes("Make the build green"));
	check("verification prompt instructs adversarial verification", verify.includes("VERIFY adversarially:"));
	check(
		"verification prompt has the done-to-CONFIRM path",
		/status:"done"/.test(verify) && verify.includes("CONFIRM"),
	);
}

async function scenarioSessionState(url) {
	const { collectLatestByKey } = await loadModule(url);
	const keyOf = (d) => d.id;

	// Only type==='custom' AND matching customType are kept.
	const mixed = [
		{ type: "message", data: { id: "a" } },
		{ type: "custom", customType: "other", data: { id: "a" } },
		{ type: "custom", customType: "goal-state", data: { id: "a", v: 1 } },
	];
	const m1 = collectLatestByKey(mixed, "goal-state", keyOf);
	check("collectLatestByKey keeps only matching custom entries", m1.size === 1 && m1.get("a")?.v === 1);

	// Falsy/missing data is skipped.
	const m2 = collectLatestByKey(
		[
			{ type: "custom", customType: "goal-state", data: undefined },
			{ type: "custom", customType: "goal-state", data: { id: "x" } },
		],
		"goal-state",
		keyOf,
	);
	check("collectLatestByKey skips entries with falsy data", m2.size === 1 && m2.has("x"));

	// Non-string key is skipped.
	const m3 = collectLatestByKey(
		[
			{ type: "custom", customType: "goal-state", data: { id: 42 } },
			{ type: "custom", customType: "goal-state", data: { id: "ok" } },
		],
		"goal-state",
		keyOf,
	);
	check("collectLatestByKey skips non-string keys", m3.size === 1 && m3.has("ok"));

	// Last write wins for a repeated key.
	const m4 = collectLatestByKey(
		[
			{ type: "custom", customType: "goal-state", data: { id: "p1", status: "pursuing" } },
			{ type: "custom", customType: "goal-state", data: { id: "p1", status: "done" } },
		],
		"goal-state",
		keyOf,
	);
	check("collectLatestByKey last-write-wins", m4.size === 1 && m4.get("p1")?.status === "done");

	check("collectLatestByKey empty input → empty map", collectLatestByKey([], "goal-state", keyOf).size === 0);
}

async function scenarioTime(url) {
	const { formatEta } = await loadModule(url);
	const now = Date.now();
	check("formatEta(null) → 'now'", formatEta(null) === "now");
	check("formatEta clamps a past time to '0s'", formatEta(now - 600_000) === "0s");
	check("formatEta formats minutes for >=60s", formatEta(now + 600_000) === "10m");
	check("formatEta formats seconds under a minute", /^[5-9]s$/.test(formatEta(now + 8_000)));
}

async function main() {
	const prompts = await buildExtension({
		name: "pi-goal-prompts-helpers",
		src: path.join(REPO_ROOT, "extensions", "pi-goal", "prompts.ts"),
		outName: "prompts.mjs",
	});
	try {
		await scenarioPrompts(prompts.url);
	} finally {
		await fs.rm(prompts.outDir, { recursive: true, force: true });
	}

	const sessionState = await buildExtension({
		name: "pi-goal-session-state-helpers",
		src: path.join(REPO_ROOT, "extensions", "pi-goal", "session-state.ts"),
		outName: "session-state.mjs",
	});
	try {
		await scenarioSessionState(sessionState.url);
	} finally {
		await fs.rm(sessionState.outDir, { recursive: true, force: true });
	}

	const time = await buildExtension({
		name: "pi-goal-time-helpers",
		src: path.join(REPO_ROOT, "extensions", "pi-goal", "time.ts"),
		outName: "time.mjs",
	});
	try {
		await scenarioTime(time.url);
	} finally {
		await fs.rm(time.outDir, { recursive: true, force: true });
	}

	console.log(`\n${counts.passed} passed, ${counts.failed} failed`);
	if (counts.failed) {
		console.log("Failures:");
		for (const failure of counts.failures) console.log(`- ${failure}`);
		process.exit(1);
	}
}

main().catch((error) => {
	console.error(error);
	process.exit(2);
});
