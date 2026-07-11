import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseReleaseFlowOptions, planReleaseFlow } from "../../release-flow.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

test("release-flow: dry-run is the default", () => {
	const opts = parseReleaseFlowOptions([]);
	assert.equal(opts.prepare, false);
	assert.equal(opts.write, false);
	assert.equal(opts.planFile, ".release-plan.json");
});

test("release-flow: maps explicit release flags", () => {
	const opts = parseReleaseFlowOptions([
		"--prepare",
		"--write",
		"--sync-docs",
		"--test",
		"--contract",
		"--publish",
		"--provenance",
		"--publish-plan",
		"tmp/plan.json",
	]);
	assert.deepEqual(opts, {
		prepare: true,
		write: true,
		syncDocs: true,
		runTest: true,
		contract: true,
		publish: true,
		provenance: true,
		planFile: "tmp/plan.json",
		skipPublishPlan: false,
	});
});

test("release-flow: plans ordered steps for a write+contract path", () => {
	const rootPkg = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8"));
	const plan = planReleaseFlow(REPO, parseReleaseFlowOptions(["--prepare", "--write", "--contract"]));
	assert.equal(plan.dryRun, false);
	assert.equal(plan.expectedTag, `v${rootPkg.version}`);
	assert.deepEqual(plan.steps, [
		"release-prepare --write",
		`release-contract --expect-tag v${rootPkg.version}`,
		"publish-npm --plan-file .release-plan.json",
	]);
});
