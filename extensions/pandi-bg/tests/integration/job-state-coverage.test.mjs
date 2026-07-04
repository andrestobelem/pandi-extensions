#!/usr/bin/env node
/**
 * Characterization coverage for `extensions/pandi-bg/job-state.ts` — the read-time
 * projection helpers (projectState / decorateStatus). These assert the CURRENT
 * behavior of the source; the source is the source of truth.
 *
 * Bootstrap note (divergent from the sibling bg-jobs.test.mjs, intentionally):
 * to drive the ownership short-circuit we must mutate the SAME `activeJobs` map
 * that job-state.ts reads. esbuild inlines `./runtime-state.js` into a normal
 * bundle, which would hide that singleton. So we bundle job-state.ts with
 * `--external:./runtime-state.js` and supply our own runtime-state.js (a real
 * Map plus byte-identical asString/asNumber) next to the bundle: Node resolves
 * the one relative specifier to the file we control, so the test and the module
 * share one `activeJobs` instance. process-liveness.js stays bundled (real), so
 * the non-owned contrast genuinely probes a reaped pid.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createChecker, loadModule } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

const { check, counts } = createChecker();

// Bundle job-state.ts with runtime-state.js kept external so the test can share
// the in-process `activeJobs` singleton with the module under test.
async function buildJobState() {
	const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-bg-job-state-"));
	await fs.writeFile(
		path.join(outDir, "runtime-state.js"),
		"export const activeJobs = new Map();\n" +
			'export const asString = (v) => (typeof v === "string" ? v : undefined);\n' +
			'export const asNumber = (v) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);\n',
	);
	const out = path.join(outDir, "job-state.mjs");
	const r = spawnSync(
		"npx",
		[
			"--no-install",
			"esbuild",
			path.join(REPO_ROOT, "extensions", "pandi-bg", "job-state.ts"),
			"--bundle",
			"--platform=node",
			"--format=esm",
			"--external:./runtime-state.js",
			`--outfile=${out}`,
		],
		{ cwd: REPO_ROOT, encoding: "utf8" },
	);
	if (r.status !== 0) throw new Error(`esbuild failed: ${r.stderr || r.stdout}`);
	return {
		moduleUrl: pathToFileURL(out).href,
		runtimeStateUrl: pathToFileURL(path.join(outDir, "runtime-state.js")).href,
	};
}

// Gap 1: an owned job (registered in activeJobs) or a terminal persisted state is a
// pure passthrough of the persisted state — the liveness probe is short-circuited, so
// no `persistedState`/`hint` is attached even when the recorded pid is long dead.
async function ownedJobShortCircuitsLivenessProbe(moduleUrl, runtimeStateUrl) {
	const { projectState, decorateStatus, deriveState } = await loadModule(moduleUrl);
	// Plain import (NO cache-busting query) so we share the exact `activeJobs` singleton
	// that the bundle's `./runtime-state.js` import resolves to.
	const { activeJobs } = await import(runtimeStateUrl);

	// A reaped pid: spawnSync waits for exit, so this pid is dead by the time we probe it.
	const dead = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
	check(
		"setup: probe child exited cleanly",
		dead.status === 0,
		JSON.stringify({ status: dead.status, pid: dead.pid }),
	);

	const jobId = "owned-job";
	activeJobs.set(jobId, {});
	try {
		const owned = projectState(jobId, "running", dead.pid);
		check("owned: persisted running passes through unchanged", owned.state === "running", JSON.stringify(owned));
		check(
			"owned: no persistedState attached (probe skipped)",
			owned.persistedState === undefined,
			JSON.stringify(owned),
		);
		check("owned: no verify-before-kill hint attached", owned.hint === undefined, JSON.stringify(owned));

		// Contrast: the SAME dead pid, NOT owned, takes the probe branch -> not 'running'.
		const orphanGap = projectState("not-owned-job", "running", dead.pid);
		check(
			"contrast: an unowned dead-pid running job is re-derived away from running",
			orphanGap.state === "interrupted" && orphanGap.persistedState === "running",
			JSON.stringify(orphanGap),
		);

		// decorateStatus mirrors the short-circuit and stamps active=true for an owned job.
		const decorated = decorateStatus(jobId, { state: "running", pid: dead.pid });
		check(
			"owned: decorateStatus keeps running and marks active",
			decorated.state === "running" && decorated.active === true,
			JSON.stringify(decorated),
		);
		check(
			"owned: decorateStatus attaches no persistedState/hint",
			decorated.persistedState === undefined && decorated.hint === undefined,
			JSON.stringify(decorated),
		);

		// deriveState is the thin .state accessor over projectState — owned passthrough too.
		check(
			"owned: deriveState returns the passthrough state",
			deriveState(jobId, { state: "running", pid: dead.pid }) === "running",
		);
	} finally {
		activeJobs.delete(jobId);
	}

	// A terminal persisted state is a passthrough regardless of ownership (never probed).
	const terminal = projectState("terminal-job", "completed", dead.pid);
	check(
		"terminal: completed passes through with no probe metadata",
		terminal.state === "completed" && terminal.persistedState === undefined && terminal.hint === undefined,
		JSON.stringify(terminal),
	);
}

// Gap 2: decorateStatus sets `active` from activeJobs membership and returns a NON-mutating
// copy — a frozen raw object for an unowned job must not throw and must be left untouched.
async function decorateStatusIsNonMutatingAndSetsActive(moduleUrl, runtimeStateUrl) {
	const { decorateStatus } = await loadModule(moduleUrl);
	const { activeJobs } = await import(runtimeStateUrl);
	check(
		"setup: registry starts without the probed job",
		!activeJobs.has("frozen-job"),
		String([...activeJobs.keys()]),
	);

	const raw = Object.freeze({ state: "completed", pid: 12345, extra: "keep-me" });
	let threw = false;
	let result;
	try {
		result = decorateStatus("frozen-job", raw);
	} catch {
		threw = true;
	}
	check("non-mutating: decorating a frozen unowned status does not throw", !threw);
	check("non-mutating: result.active is false for an unowned job", result?.active === false, JSON.stringify(result));
	check("non-mutating: original raw.state is unchanged", raw.state === "completed");
	check("non-mutating: original raw was not given an active flag", !("active" in raw));
	check(
		"non-mutating: unrelated fields are carried onto the copy",
		result?.extra === "keep-me" && result?.pid === 12345,
		JSON.stringify(result),
	);
	check("non-mutating: returned object is a distinct copy", result !== raw);
}

async function main() {
	const { moduleUrl, runtimeStateUrl } = await buildJobState();
	await ownedJobShortCircuitsLivenessProbe(moduleUrl, runtimeStateUrl);
	await decorateStatusIsNonMutatingAndSetsActive(moduleUrl, runtimeStateUrl);

	console.log(`\n${counts.passed} passed, ${counts.failed} failed`);
	if (counts.failed) {
		console.error(counts.failures.join("\n"));
		process.exit(1);
	}
}

main().catch((err) => {
	console.error(err?.stack || err);
	process.exit(1);
});
