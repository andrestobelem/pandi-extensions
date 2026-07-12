import assert from "node:assert/strict";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
	assertVerifiedPublishPlan,
	parseReleaseFlowOptions,
	planReleaseFlow,
	printConfirmation,
	readExpectedTag,
	releaseCommitMessage,
	requirePushConfirmation,
	runStep,
} from "../../release-flow.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

test("release-flow: dry-run is the default", () => {
	const opts = parseReleaseFlowOptions([]);
	assert.equal(opts.go, false);
	assert.equal(opts.prepare, false);
	assert.equal(opts.write, false);
	assert.equal(opts.untilClean, false);
	assert.equal(opts.printConfirmation, false);
	assert.equal(opts.planFile, ".release-plan.json");
});

test("release-flow: --go enables the full preflight bundle", () => {
	const opts = parseReleaseFlowOptions(["--go"]);
	assert.equal(opts.go, true);
	assert.equal(opts.prepare, true);
	assert.equal(opts.write, true);
	assert.equal(opts.untilClean, true);
	assert.equal(opts.syncDocs, true);
	assert.equal(opts.runTest, true);
	assert.equal(opts.contract, true);
	assert.equal(opts.commit, false);
});

test("release-flow: --ship maps commit, tag and push", () => {
	const opts = parseReleaseFlowOptions(["--ship", "--confirm", "v0.3.11"]);
	assert.equal(opts.commit, true);
	assert.equal(opts.tag, true);
	assert.equal(opts.push, true);
	assert.equal(opts.confirm, "v0.3.11");
});

test("release-flow: maps ship flags and confirmation", () => {
	const opts = parseReleaseFlowOptions(["--go", "--fast", "--publish-plan", "tmp/plan.json", "--allow-dirty"]);
	assert.deepEqual(opts, {
		go: true,
		printConfirmation: false,
		allowDirty: true,
		prepare: true,
		write: true,
		untilClean: true,
		syncDocs: true,
		runTest: true,
		fastTest: true,
		contract: true,
		publish: false,
		provenance: false,
		commit: false,
		tag: false,
		push: false,
		confirm: undefined,
		planFile: "tmp/plan.json",
		skipPublishPlan: false,
	});
});

test("release-flow: plans ordered steps for --go", () => {
	const expectedTag = readExpectedTag(REPO);
	const plan = planReleaseFlow(REPO, parseReleaseFlowOptions(["--go"]));
	assert.equal(plan.dryRun, false);
	assert.equal(plan.expectedTag, expectedTag);
	assert.deepEqual(plan.steps, [
		"release-prepare --write --until-clean",
		"sync:docs:html",
		"npm test",
		"release-contract",
		"publish-npm verify plan",
	]);
});

test("release-flow: push confirmation must match the expected tag", () => {
	assert.doesNotThrow(() => requirePushConfirmation("v0.3.10", "v0.3.10"));
	assert.throws(() => requirePushConfirmation("v0.3.10", "v0.3.11"), /push requires --confirm v0\.3\.10/);
});

test("release-flow: commit message follows the release tag", () => {
	assert.equal(releaseCommitMessage("v0.3.10"), "chore(release): prepare v0.3.10");
});

test("release-flow: print-confirmation advertises the ship command", () => {
	const lines = [];
	const original = console.log;
	console.log = (...args) => lines.push(args.join(" "));
	try {
		printConfirmation("v0.3.10");
	} finally {
		console.log = original;
	}
	assert.match(lines.join("\n"), /Release confirmation token: v0\.3\.10/);
	assert.match(lines.join("\n"), /--ship --confirm v0\.3\.10/);
});

test("release-flow: publish-plan verification fails closed", () => {
	assert.throws(
		() => assertVerifiedPublishPlan({ status: 1, output: "npm ERR network timeout\n" }),
		/publish classification failed \(exit 1\)/,
	);
	assert.throws(
		() => assertVerifiedPublishPlan({ status: 1, output: "1 need a version bump.\n" }),
		/publish plan still has packages that need a version bump/,
	);
	assert.deepEqual(assertVerifiedPublishPlan({ status: 0, output: "0 need a version bump.\n" }), {
		status: 0,
		output: "0 need a version bump.\n",
	});
});

test("release-flow: steps fail closed by default", () => {
	const original = console.log;
	console.log = () => {};
	try {
		assert.throws(
			() => runStep("publish npm", "npm", ["publish"], { spawn: () => ({ status: 1, stdout: "", stderr: "" }) }),
			/publish npm failed \(exit 1\)/,
		);
	} finally {
		console.log = original;
	}
});
