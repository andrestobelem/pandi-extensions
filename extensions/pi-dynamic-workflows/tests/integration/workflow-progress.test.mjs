#!/usr/bin/env node
/**
 * Behavioral contract for auto-derived batch progress ("¿por dónde va?").
 *
 * agents() already threads AgentPhaseInfo per item, and both `agent N start:` and
 * `agent N end:` log entries carry {phaseId, phaseIndex, phaseTotal, phaseLabel}
 * in details. But the status line only showed agentsDone/agentsStarted — done over
 * STARTED, not over the batch TOTAL — so "5/5" could look complete while 11 items
 * of a 16-item batch had not even started.
 *
 * Contract pinned here (presentation.ts, pure derivation):
 *   - workflowProgress(logs).batch is derived from phase details: the CURRENT batch
 *     is the one with the highest phaseId; done counts its `end` events, started its
 *     `start` events, total/label come from the phase fields.
 *   - Logs without phase details (plain agent()/parallel() calls) → batch undefined,
 *     and the legacy counters (agentsStarted/agentsDone/agentsRunning/bashDone) are
 *     unchanged.
 *   - Malformed phase details (missing/non-numeric phaseTotal) are ignored.
 *   - workflowProgressLabel(progress) renders the human text for the status line:
 *     batch → "Review 5/16"; no batch → legacy "2/3"; nothing started → "".
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExtension, createChecker, loadModule } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

const { check, counts } = createChecker();

const T = "2026-07-03T00:00:00.000Z";
const start = (id, name, phase) => ({
	time: T,
	message: `agent ${id} start: ${name}`,
	details: { artifactPath: `/tmp/${id}.md`, ...(phase ?? {}) },
});
const end = (id, name, phase) => ({
	time: T,
	message: `agent ${id} end: ${name}`,
	details: { ok: true, code: 0, elapsedMs: 1000, ...(phase ?? {}) },
});
const phase = (id, index, total, label) => ({
	phaseId: id,
	phaseIndex: index,
	phaseTotal: total,
	...(label ? { phaseLabel: label } : {}),
});

async function main() {
	const { url } = await buildExtension({
		name: "pi-dwf-workflow-progress",
		src: path.join(REPO_ROOT, "extensions", "pi-dynamic-workflows", "presentation.ts"),
		outName: "presentation.mjs",
		stubs: { tui: true },
	});
	const mod = await loadModule(url);
	const { workflowProgress, workflowProgressLabel } = mod;
	check("workflowProgress exported", typeof workflowProgress === "function");
	check("workflowProgressLabel exported", typeof workflowProgressLabel === "function");
	if (typeof workflowProgress !== "function" || typeof workflowProgressLabel !== "function") {
		report();
		return;
	}

	// --- legacy counters unchanged (no phase details anywhere) -----------------
	const legacy = workflowProgress([
		start(1, "a"),
		end(1, "a"),
		start(2, "b"),
		{ time: T, message: "bash end: ls", details: {} },
	]);
	check("legacy: agentsStarted", legacy.agentsStarted === 2, JSON.stringify(legacy));
	check("legacy: agentsDone", legacy.agentsDone === 1);
	check("legacy: agentsRunning", legacy.agentsRunning === 1);
	check("legacy: bashDone", legacy.bashDone === 1);
	check("legacy: no batch without phase details", legacy.batch === undefined);

	// --- batch derived from phase details --------------------------------------
	const review = workflowProgress([
		start(1, "review:a", phase(1, 1, 16, "Review")),
		start(2, "review:b", phase(1, 2, 16, "Review")),
		start(3, "review:c", phase(1, 3, 16, "Review")),
		end(1, "review:a", phase(1, 1, 16, "Review")),
		end(2, "review:b", phase(1, 2, 16, "Review")),
	]);
	check("batch present", !!review.batch, JSON.stringify(review.batch));
	check("batch label", review.batch?.label === "Review");
	check("batch total", review.batch?.total === 16);
	check("batch done counts end events", review.batch?.done === 2);
	check("batch started counts start events", review.batch?.started === 3);

	// --- current batch = highest phaseId ---------------------------------------
	const twoPhases = workflowProgress([
		start(1, "scout", phase(1, 1, 4, "Scout")),
		end(1, "scout", phase(1, 1, 4, "Scout")),
		start(2, "verify", phase(2, 1, 9, "Verify")),
		end(2, "verify", phase(2, 1, 9, "Verify")),
		start(3, "verify", phase(2, 2, 9, "Verify")),
	]);
	check("picks highest phaseId", twoPhases.batch?.label === "Verify", JSON.stringify(twoPhases.batch));
	check("highest phase total", twoPhases.batch?.total === 9);
	check("highest phase done", twoPhases.batch?.done === 1);

	// --- default label when phaseLabel missing ---------------------------------
	const unlabeled = workflowProgress([start(1, "x", phase(3, 1, 5))]);
	check("default label agents-<id>", unlabeled.batch?.label === "agents-3", JSON.stringify(unlabeled.batch));

	// --- malformed phase details ignored ---------------------------------------
	const malformed = workflowProgress([
		start(1, "x", { phaseId: 1, phaseIndex: 1 }), // no phaseTotal
		start(2, "y", { phaseId: "z", phaseIndex: 1, phaseTotal: "many" }), // non-numeric
	]);
	check("malformed details → no batch", malformed.batch === undefined, JSON.stringify(malformed.batch));

	// --- workflowProgressLabel rendering ----------------------------------------
	check(
		"label: batch → 'Review 2/16'",
		workflowProgressLabel(review) === "Review 2/16",
		workflowProgressLabel(review),
	);
	check("label: legacy fallback → '1/2'", workflowProgressLabel(legacy) === "1/2", workflowProgressLabel(legacy));
	check(
		"label: nothing started → ''",
		workflowProgressLabel(workflowProgress([])) === "",
		JSON.stringify(workflowProgressLabel(workflowProgress([]))),
	);

	report();
}

function report() {
	console.log(`TOTAL: ${counts.passed} passed, ${counts.failed} failed`);
	if (counts.failed > 0) {
		console.error("\nFailures:");
		for (const failure of counts.failures) console.error(`- ${failure}`);
		process.exit(1);
	}
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
