/**
 * Characterization tests for the pure `/plan` command-intent parser.
 *
 * The runtime handler owns side effects (notify, dashboard overlay, plan state), but the
 * command grammar is a domain concept of its own: exact control commands, toggle
 * commands, and otherwise a free-form planning task. These tests pin the current
 * dispatch rules before extracting them from index.ts.
 *
 * Run it:    node extensions/pandi-plan/tests/integration/command-intent-coverage.test.mjs
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExtension, createChecker, loadModule } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

const { check, counts } = createChecker();

async function buildCommandIntent() {
	return await buildExtension({
		name: "pi-plan-command-intent-integration",
		src: path.join(REPO_ROOT, "extensions", "pandi-plan", "command-intent.ts"),
		outName: "command-intent.mjs",
		stubs: {},
	});
}

function same(name, actual, expected) {
	check(
		name,
		JSON.stringify(actual) === JSON.stringify(expected),
		`${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`,
	);
}

async function intentParsing(url) {
	const { parsePlanCommandIntent } = await loadModule(url);
	check("parsePlanCommandIntent is exported", typeof parsePlanCommandIntent === "function");

	same("intent: exact status", parsePlanCommandIntent("status"), { kind: "status" });
	same("intent: exact dashboard", parsePlanCommandIntent("dashboard"), { kind: "dashboard" });
	same("intent: exact tui alias", parsePlanCommandIntent("tui"), { kind: "dashboard" });
	same("intent: exact exit", parsePlanCommandIntent("exit"), {
		kind: "exit",
		command: "exit",
		reason: "exit por el usuario",
	});
	same("intent: exact cancel", parsePlanCommandIntent("cancel"), {
		kind: "exit",
		command: "cancel",
		reason: "cancel por el usuario",
	});

	same("intent: status with text is a task", parsePlanCommandIntent("status report"), {
		kind: "start",
		task: "status report",
	});
	same("intent: exit with text is a task", parsePlanCommandIntent("exit later"), {
		kind: "start",
		task: "exit later",
	});
	same("intent: dashboard with text is a task", parsePlanCommandIntent("dashboard redesign"), {
		kind: "start",
		task: "dashboard redesign",
	});

	same("intent: ultracode status by default", parsePlanCommandIntent("ultracode"), {
		kind: "toggle",
		key: "ultracode",
		label: "ultracode",
		action: "status",
	});
	same("intent: ultracode on", parsePlanCommandIntent("ultracode on"), {
		kind: "toggle",
		key: "ultracode",
		label: "ultracode",
		action: "on",
	});
	same("intent: steps-ultracode off", parsePlanCommandIntent("steps-ultracode off"), {
		kind: "toggle",
		key: "ultracodeSteps",
		label: "steps-ultracode",
		action: "off",
	});
	same("intent: invalid toggle is explicit", parsePlanCommandIntent("ultracode maybe"), {
		kind: "invalid-toggle",
		label: "ultracode",
	});

	same("intent: trims task", parsePlanCommandIntent("  design a feature  "), {
		kind: "start",
		task: "design a feature",
	});
	same("intent: empty input remains start with empty task", parsePlanCommandIntent("   "), {
		kind: "start",
		task: "",
	});
	same(
		"intent: flags stay part of the start task for startPlan flag parsing",
		parsePlanCommandIntent("--ultracode build it"),
		{
			kind: "start",
			task: "--ultracode build it",
		},
	);
}

async function main() {
	const { outDir, url } = await buildCommandIntent();
	try {
		await intentParsing(url);
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
