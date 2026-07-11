/**
 * Tests chicos para el parser puro de intención de `/goal`.
 *
 * Fijan la gramática de flags, criterios y subcomandos antes de extraerla de
 * index.ts. Las suites end-to-end siguen cubriendo el engine persistente.
 *
 * Ejecutarlo:
 *   node extensions/pandi-goal/tests/integration/goal-command-intent.test.mjs
 */

import { createChecker, loadModule } from "../../../shared/test/harness.mjs";
import { buildCommandIntent } from "./goal-test-support.mjs";

const { check, counts } = createChecker();

function same(label, actual, expected) {
	check(label, JSON.stringify(actual) === JSON.stringify(expected), `actual=${JSON.stringify(actual)}`);
}

async function parserContract(url) {
	const mod = await loadModule(url);
	const { extractUltracodeFlag, parseGoalArgs, parseGoalCommandIntent } = mod;

	same("flag: strips --ultracode and normalizes whitespace", extractUltracodeFlag(" --ultracode  ship   it "), {
		rest: "ship it",
		ultracode: true,
	});
	same("flag: strips --uc case-insensitively after criteria", extractUltracodeFlag("ship -- green --UC"), {
		rest: "ship -- green",
		ultracode: true,
	});
	same("flag: leaves normal text untouched apart from token normalization", extractUltracodeFlag("ship it"), {
		rest: "ship it",
		ultracode: false,
	});

	same("args: objective only", parseGoalArgs("ship dashboard"), {
		objective: "ship dashboard",
		ultracode: false,
	});
	same("args: criteria after separator", parseGoalArgs("ship dashboard -- tests green"), {
		objective: "ship dashboard",
		successCriteria: "tests green",
		ultracode: false,
	});
	same("args: ultracode flag can appear before objective", parseGoalArgs("--uc ship dashboard -- tests green"), {
		objective: "ship dashboard",
		successCriteria: "tests green",
		ultracode: true,
	});
	same("args: ultracode flag can appear after criteria", parseGoalArgs("ship dashboard -- tests green --ULTRACODE"), {
		objective: "ship dashboard",
		successCriteria: "tests green",
		ultracode: true,
	});
	same("args: trailing separator token stays in objective", parseGoalArgs("ship dashboard -- "), {
		objective: "ship dashboard --",
		ultracode: false,
	});

	same("intent: stop with id", parseGoalCommandIntent("stop abc123"), {
		kind: "stop",
		rest: "abc123",
	});
	same("intent: status lowercases only command token", parseGoalCommandIntent("STATUS GoalA"), {
		kind: "status",
		rest: "GoalA",
	});
	same(
		"intent: stop plus criteria separator is a start objective",
		parseGoalCommandIntent("stop rollout -- tests green"),
		{
			kind: "start",
			rest: "stop rollout -- tests green",
		},
	);
	same(
		"intent: status plus criteria separator is a start objective",
		parseGoalCommandIntent("status rollout -- tests green"),
		{
			kind: "start",
			rest: "status rollout -- tests green",
		},
	);
	same("intent: default is start with trimmed args", parseGoalCommandIntent("  ship dashboard  "), {
		kind: "start",
		rest: "ship dashboard",
	});
	same("intent: empty args route to start for usage message", parseGoalCommandIntent("   "), {
		kind: "start",
		rest: "",
	});
}

async function main() {
	const { outDir, url } = await buildCommandIntent();
	try {
		await parserContract(url);
	} finally {
		const fs = await import("node:fs/promises");
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
