/**
 * Characterization tests for the PURE session-state replay kernel,
 * extensions/pandi-plan/session-state.ts.
 *
 * Why this file exists
 * --------------------
 * `plan-approval.test.mjs` drives the WHOLE state machine (rehydrate, last-wins by
 * planId, junk tolerance) through the real index.ts handlers. It never tests the
 * extracted `collectLatestByKey` helper DIRECTLY. This suite pins the kernel's
 * observable contract on its own, so a regression in the pure collection logic is
 * caught at its source rather than only via the much heavier integration path.
 *
 * The contract under test (from the source doc):
 *   - keep only entries whose type === "custom" AND customType === <arg>
 *   - skip entries with no/falsy data
 *   - skip entries whose extracted key is not a string
 *   - LAST WRITE WINS (entries scanned oldest -> newest; Map.set overwrites)
 *
 * session-state.ts only `import type`s the SDK (it is a pure module), so it builds
 * with NO stubs. We import the NAMED export and call it directly — no pi/ctx mock.
 *
 * Run it:    node extensions/pandi-plan/tests/integration/session-state-coverage.test.mjs
 * Exit code: 0 = all checks passed; 1 = a behavioral check failed; 2 = harness crashed.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExtension, createChecker, loadModule } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// extensions/pandi-plan/tests/integration/ -> repo root is four levels up.
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

const { check, counts } = createChecker();

// session-state.ts only `import type`s the SDK -> pure module, builds with NO stubs.
async function buildSessionState() {
	return await buildExtension({
		name: "pi-plan-session-state-coverage",
		src: path.join(REPO_ROOT, "extensions", "pandi-plan", "session-state.ts"),
		outName: "session-state.mjs",
		stubs: {},
	});
}

const planEntry = (data) => ({ type: "custom", customType: "plan-state", data });

async function main() {
	const { outDir, url } = await buildSessionState();
	try {
		const { collectLatestByKey } = await loadModule(url);
		check("collectLatestByKey is exported as a function", typeof collectLatestByKey === "function");

		// --- The flagged gap: last write wins for repeated keys (oldest -> newest scan). ---
		{
			const entries = [
				planEntry({ planId: "p1", status: "planning" }),
				planEntry({ planId: "p1", status: "approved" }),
			];
			const m = collectLatestByKey(entries, "plan-state", (d) => d.planId);
			check("last-wins: Map size is 1 for a single repeated key", m.size === 1);
			check("last-wins: latest (approved) snapshot wins", m.get("p1")?.status === "approved");

			// Reverse the order -> the result flips (proves it is order-dependent last-wins).
			const reversed = collectLatestByKey([...entries].reverse(), "plan-state", (d) => d.planId);
			check("last-wins(reversed): Map size still 1", reversed.size === 1);
			check("last-wins(reversed): result flips to planning", reversed.get("p1")?.status === "planning");
		}

		// --- Multiple distinct keys are all retained, each at its latest snapshot. ---
		{
			const entries = [
				planEntry({ planId: "a", status: "planning" }),
				planEntry({ planId: "b", status: "planning" }),
				planEntry({ planId: "a", status: "approved" }),
				planEntry({ planId: "b", status: "exited" }),
			];
			const m = collectLatestByKey(entries, "plan-state", (d) => d.planId);
			check("multi-key: both distinct keys retained (size 2)", m.size === 2);
			check("multi-key: key a at its latest (approved)", m.get("a")?.status === "approved");
			check("multi-key: key b at its latest (exited)", m.get("b")?.status === "exited");
		}

		// --- Filter: non-custom entries are skipped. ---
		{
			const entries = [
				{ type: "message", customType: "plan-state", data: { planId: "p1", status: "planning" } },
				planEntry({ planId: "p1", status: "approved" }),
			];
			const m = collectLatestByKey(entries, "plan-state", (d) => d.planId);
			check(
				"filter(non-custom): message entry ignored, only custom kept",
				m.size === 1 && m.get("p1")?.status === "approved",
			);
		}

		// --- Filter: a mismatched customType is skipped. ---
		{
			const entries = [
				{ type: "custom", customType: "loop-state", data: { planId: "p1", status: "running" } },
				planEntry({ planId: "p1", status: "planning" }),
			];
			const m = collectLatestByKey(entries, "plan-state", (d) => d.planId);
			check("filter(customType): foreign customType ignored", m.size === 1 && m.get("p1")?.status === "planning");
			// And asking for the OTHER customType picks only that one.
			const loops = collectLatestByKey(entries, "loop-state", (d) => d.planId);
			check(
				"filter(customType): selecting loop-state returns only the loop entry",
				loops.size === 1 && loops.get("p1")?.status === "running",
			);
		}

		// --- Filter: falsy data (null/undefined) is skipped without throwing. ---
		{
			const entries = [planEntry(null), planEntry(undefined), planEntry({ planId: "p1", status: "planning" })];
			const m = collectLatestByKey(entries, "plan-state", (d) => d.planId);
			check(
				"filter(falsy-data): null/undefined data skipped, valid kept",
				m.size === 1 && m.get("p1")?.status === "planning",
			);
		}

		// --- Filter: a non-string extracted key is skipped. ---
		{
			const entries = [
				planEntry({ planId: 123, status: "planning" }), // numeric key -> skipped
				planEntry({ status: "no-id" }), // undefined key -> skipped
				planEntry({ planId: "p1", status: "approved" }),
			];
			const m = collectLatestByKey(entries, "plan-state", (d) => d.planId);
			check("filter(non-string-key): numeric/missing keys skipped", m.size === 1);
			check("filter(non-string-key): only the string-keyed entry kept", m.get("p1")?.status === "approved");
		}

		// --- Empty input returns an empty Map. ---
		{
			const m = collectLatestByKey([], "plan-state", (d) => d.planId);
			check("empty: empty input yields an empty Map", m instanceof Map && m.size === 0);
		}

		// --- All-filtered input yields an empty Map (no throw on a pile of junk). ---
		{
			const entries = [
				{ type: "message", data: { role: "user" } },
				{ type: "custom", customType: "loop-state", data: { loopId: "x" } },
				planEntry(null),
				planEntry({ task: "no id" }),
			];
			const m = collectLatestByKey(entries, "plan-state", (d) => d.planId);
			check("all-filtered: nothing valid yields an empty Map", m instanceof Map && m.size === 0);
		}

		// --- The returned values are the SAME data object references (no copying). ---
		{
			const data = { planId: "p1", status: "planning" };
			const m = collectLatestByKey([planEntry(data)], "plan-state", (d) => d.planId);
			check("identity: stored value is the original data object reference", m.get("p1") === data);
		}

		// --- Works over any Iterable (e.g. a generator), not just arrays. ---
		{
			function* gen() {
				yield planEntry({ planId: "p1", status: "planning" });
				yield planEntry({ planId: "p1", status: "approved" });
			}
			const m = collectLatestByKey(gen(), "plan-state", (d) => d.planId);
			check(
				"iterable: generator input honored, last-wins still applies",
				m.size === 1 && m.get("p1")?.status === "approved",
			);
		}
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
