#!/usr/bin/env node
/**
 * Regression: "latest" must resolve by startedAt, not directory mtime.
 *
 * Farley review 2026-07-03, finding #2 (High): getRunDirs sorts run dirs by
 * mtimeMs, and listRuns/resolveRun inherit that order. status.json is rewritten
 * on every log()/resume/status refresh, so ANY write in an OLD run dir bumps its
 * mtime above newer runs — and `latest` is the default target for resume, view,
 * cancel and delete. Cleanup (run-state.ts) already orders by startedAt; the
 * default resolution must agree with it.
 *
 * Contract pinned here (run-view.ts):
 *   - listRuns returns runs ordered by startedAt (newest first) even when an
 *     older run dir has a newer mtime.
 *   - resolveRun(ctx, undefined) — "latest" — returns the newest startedAt.
 *   - Records with missing/unparseable startedAt sort after dated ones and do
 *     not crash the listing.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExtension, createChecker, loadModule, sdkStub } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const { check, counts } = createChecker();

async function makeRun(runsRoot, runId, startedAt) {
	const runDir = path.join(runsRoot, runId);
	await fs.mkdir(runDir, { recursive: true });
	await fs.writeFile(
		path.join(runDir, "status.json"),
		`${JSON.stringify({
			workflow: "w",
			scope: "project",
			runId,
			runDir,
			state: "completed",
			background: false,
			...(startedAt ? { startedAt } : {}),
			updatedAt: startedAt ?? "2026-01-01T00:00:00.000Z",
			elapsedMs: 1,
			agentCount: 0,
			logs: [],
		})}\n`,
		"utf8",
	);
	return runDir;
}

async function main() {
	const { url } = await buildExtension({
		name: "pi-dwf-latest-started-at",
		src: path.join(REPO_ROOT, "extensions", "pi-dynamic-workflows", "run-view.ts"),
		outName: "run-view.mjs",
		stubs: {
			typebox: true,
			typeboxValue: true,
			ai: true,
			tui: true,
			sdk: (dir) => sdkStub(dir, { customEditor: "render" }),
		},
		npx: "--yes",
	});
	const { listRuns, resolveRun } = await loadModule(url);
	check("listRuns exported", typeof listRuns === "function");
	check("resolveRun exported", typeof resolveRun === "function");

	const project = await fs.mkdtemp(path.join(os.tmpdir(), "pi-dw-latest-"));
	const runsRoot = path.join(project, ".pi", "workflows", "runs");
	const ctx = { cwd: project, isProjectTrusted: () => true };

	// OLD run created… then B (newer startedAt)… then A's status.json rewritten,
	// giving the OLD dir the NEWEST mtime (what any log/status refresh does).
	const dirA = await makeRun(runsRoot, "2026-07-01T00-00-00-000Z-old-run", "2026-07-01T00:00:00.000Z");
	await makeRun(runsRoot, "2026-07-02T00-00-00-000Z-new-run", "2026-07-02T00:00:00.000Z");
	await new Promise((r) => setTimeout(r, 20));
	const statusA = path.join(dirA, "status.json");
	await fs.writeFile(statusA, await fs.readFile(statusA, "utf8"), "utf8");
	const future = new Date(Date.now() + 60_000);
	await fs.utimes(dirA, future, future);
	await fs.utimes(statusA, future, future);

	const runs = await listRuns(ctx);
	check("both runs listed", runs.length === 2, JSON.stringify(runs.map((r) => r.runId)));
	check(
		"listRuns orders by startedAt, not mtime",
		runs[0]?.runId === "2026-07-02T00-00-00-000Z-new-run",
		JSON.stringify(runs.map((r) => r.runId)),
	);
	const latest = await resolveRun(ctx, undefined);
	check("latest = newest startedAt", latest.runId === "2026-07-02T00-00-00-000Z-new-run", latest.runId);

	// Missing startedAt: sorts after dated runs, no crash.
	await makeRun(runsRoot, "1999-no-started-at", undefined);
	const withUndated = await listRuns(ctx);
	check("undated run listed without crashing", withUndated.length === 3);
	check(
		"undated run sorts after dated ones",
		withUndated[withUndated.length - 1]?.runId === "1999-no-started-at",
		JSON.stringify(withUndated.map((r) => r.runId)),
	);

	console.log(`\nTOTAL: ${counts.passed} passed, ${counts.failed} failed`);
	if (counts.failed) {
		console.log(counts.failures.map((f) => `- ${f}`).join("\n"));
		process.exit(1);
	}
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
