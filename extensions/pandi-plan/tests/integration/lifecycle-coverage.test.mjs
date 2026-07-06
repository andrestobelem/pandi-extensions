/**
 * Characterization tests for the pure `/plan` lifecycle transitions.
 *
 * The runtime owns effects (persist, status line, wake, notify). lifecycle.ts only
 * names the small state mutations that already existed inline in index.ts.
 *
 * Run it:    node extensions/pandi-plan/tests/integration/lifecycle-coverage.test.mjs
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExtension, createChecker, loadModule } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

const { check, counts } = createChecker();

async function buildLifecycle() {
	return await buildExtension({
		name: "pi-plan-lifecycle-integration",
		src: path.join(REPO_ROOT, "extensions", "pandi-plan", "lifecycle.ts"),
		outName: "lifecycle.mjs",
		stubs: {},
	});
}

function plan(overrides = {}) {
	return {
		planId: "p1",
		task: "model lifecycle",
		active: true,
		status: "planning",
		submissions: 0,
		rejections: 0,
		startedAt: 1,
		updatedAt: "2026-07-06T00:00:00.000Z",
		...overrides,
	};
}

async function lifecycleTransitions(url) {
	const { markPlanApproved, markPlanExited, markPlanOnlyRecorded, markPlanRejected, recordPlanSubmission } =
		await loadModule(url);

	for (const [name, fn] of Object.entries({
		recordPlanSubmission,
		markPlanOnlyRecorded,
		markPlanApproved,
		markPlanRejected,
		markPlanExited,
	})) {
		check(`${name} is exported`, typeof fn === "function");
	}

	const submitted = plan();
	const firstSubmission = recordPlanSubmission(submitted, "first plan");
	check("submit: returns first submission number", firstSubmission === 1);
	check("submit: stores lastPlan", submitted.lastPlan === "first plan");
	check("submit: increments submissions", submitted.submissions === 1);
	check("submit: keeps status planning", submitted.status === "planning");
	check("submit: keeps gate active", submitted.active === true);

	const secondSubmission = recordPlanSubmission(submitted, "second plan");
	check("submit: returns second submission number", secondSubmission === 2);
	check("submit: replaces lastPlan", submitted.lastPlan === "second plan");
	check("submit: increments from existing count", submitted.submissions === 2);

	const planOnly = plan({ submissions: 1, lastPlan: "plan-only" });
	markPlanOnlyRecorded(planOnly);
	check("plan-only: status becomes planned", planOnly.status === "planned");
	check("plan-only: gate stays active", planOnly.active === true);
	check("plan-only: counters are preserved", planOnly.submissions === 1 && planOnly.rejections === 0);

	const approved = plan({ submissions: 2, rejections: 1, lastPlan: "approved plan" });
	markPlanApproved(approved);
	check("approve: status becomes approved", approved.status === "approved");
	check("approve: gate is lifted", approved.active === false);
	check("approve: counters are preserved", approved.submissions === 2 && approved.rejections === 1);
	check("approve: lastPlan is preserved", approved.lastPlan === "approved plan");

	const rejected = plan({ submissions: 1 });
	markPlanRejected(rejected);
	check("reject: status returns to planning", rejected.status === "planning");
	check("reject: gate stays active", rejected.active === true);
	check("reject: increments rejections", rejected.rejections === 1);
	check("reject: preserves submissions", rejected.submissions === 1);

	const exited = plan({ submissions: 1, rejections: 1 });
	markPlanExited(exited);
	check("exit: status becomes exited", exited.status === "exited");
	check("exit: gate is lifted", exited.active === false);
	check("exit: counters are preserved", exited.submissions === 1 && exited.rejections === 1);
}

async function main() {
	const { outDir, url } = await buildLifecycle();
	try {
		await lifecycleTransitions(url);
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
