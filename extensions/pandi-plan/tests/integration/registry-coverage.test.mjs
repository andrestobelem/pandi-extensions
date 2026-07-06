/**
 * Characterization tests for the pure `/plan` runtime-registry helpers.
 *
 * The extension runtime still owns the mutable Map and session effects. registry.ts
 * only captures the collection semantics that were previously inline in index.ts.
 *
 * Run it:    node extensions/pandi-plan/tests/integration/registry-coverage.test.mjs
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExtension, createChecker, loadModule } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

const { check, counts } = createChecker();

async function buildRegistry() {
	return await buildExtension({
		name: "pi-plan-registry-integration",
		src: path.join(REPO_ROOT, "extensions", "pandi-plan", "registry.ts"),
		outName: "registry.mjs",
		stubs: {},
	});
}

function plan(planId, overrides = {}) {
	return {
		planId,
		task: `task ${planId}`,
		active: false,
		status: "exited",
		submissions: 0,
		rejections: 0,
		startedAt: 1,
		updatedAt: "2026-07-06T00:00:00.000Z",
		...overrides,
	};
}

async function registryHelpers(url) {
	const { findActivePlan, findLastPlan, hasActivePlan, overlayRuntimePlans, restoreActivePlans } =
		await loadModule(url);

	for (const [name, fn] of Object.entries({
		findActivePlan,
		findLastPlan,
		hasActivePlan,
		overlayRuntimePlans,
		restoreActivePlans,
	})) {
		check(`${name} is exported`, typeof fn === "function");
	}

	const inactiveOnly = [plan("old"), plan("done", { status: "approved" })];
	check("active: none returns undefined", findActivePlan(inactiveOnly) === undefined);
	check("active: none reports false", hasActivePlan(inactiveOnly) === false);

	const firstActive = plan("first", { active: true, status: "planning" });
	const secondActive = plan("second", { active: true, status: "planning" });
	const mixed = [plan("closed"), firstActive, secondActive];
	check("active: returns the first active plan", findActivePlan(mixed) === firstActive);
	check("active: reports true", hasActivePlan(mixed) === true);

	check("last: empty returns undefined", findLastPlan([]) === undefined);
	check("last: returns the final iterated plan", findLastPlan(mixed) === secondActive);

	const existing = plan("keep", { active: true, task: "runtime copy wins" });
	const restoreTarget = new Map([[existing.planId, existing]]);
	const activeSnapshot = plan("restore", { active: true, status: "planning" });
	const terminalSnapshot = plan("skip", { active: false, status: "approved" });
	const duplicateSnapshot = plan("keep", { active: true, task: "session copy should not overwrite" });
	restoreActivePlans(restoreTarget, [terminalSnapshot, activeSnapshot, duplicateSnapshot]);
	check("restore: keeps existing runtime copy", restoreTarget.get("keep") === existing);
	check("restore: skips terminal snapshots", !restoreTarget.has("skip"));
	check("restore: adds active snapshots", restoreTarget.get("restore")?.planId === "restore");
	check("restore: clones restored snapshot", restoreTarget.get("restore") !== activeSnapshot);

	const persistedOld = plan("old", { task: "persisted old" });
	const persistedShared = plan("shared", { task: "persisted shared" });
	const runtimeShared = plan("shared", { active: true, status: "planning", task: "runtime shared" });
	const runtimeNew = plan("new", { active: true, status: "planning", task: "runtime new" });
	const overlay = overlayRuntimePlans(
		new Map([
			["old", persistedOld],
			["shared", persistedShared],
		]),
		[runtimeShared, runtimeNew],
	);
	check(
		"overlay: preserves previous order for replaced keys",
		overlay.map((p) => p.planId).join(",") === "old,shared,new",
	);
	check("overlay: replaces persisted copy with runtime copy", overlay[1] === runtimeShared);
	check("overlay: appends runtime-only plans", overlay[2] === runtimeNew);
}

async function main() {
	const { outDir, url } = await buildRegistry();
	try {
		await registryHelpers(url);
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
