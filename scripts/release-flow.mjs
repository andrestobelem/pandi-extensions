#!/usr/bin/env node
/**
 * Orquesta el preflight y el ship de release de pandi-extensions. Dry-run por defecto.
 *
 * Uso:
 *   node scripts/release-flow.mjs
 *   node scripts/release-flow.mjs --go
 *   node scripts/release-flow.mjs --print-confirmation
 *   node scripts/release-flow.mjs --commit --tag --push --confirm v0.3.11
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { valueAfter } from "./lib/cli-args.mjs";
import { readJsonFile } from "./lib/json-io.mjs";
import { expectedSuiteTag } from "./release-contract.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DEFAULT_PLAN_FILE = ".release-plan.json";

export const RELEASE_STAGE_PATHS = [
	"package.json",
	"package-lock.json",
	"docs/setup.md",
	"docs/html/setup.html",
	"RELEASING.md",
];

export function parseReleaseFlowOptions(args) {
	const go = args.includes("--go");
	const ship = args.includes("--ship");
	return {
		go,
		printConfirmation: args.includes("--print-confirmation"),
		allowDirty: args.includes("--allow-dirty"),
		prepare: go || args.includes("--prepare"),
		write: go || args.includes("--write"),
		untilClean: go || args.includes("--until-clean"),
		syncDocs: go || args.includes("--sync-docs"),
		runTest: go || args.includes("--test"),
		fastTest: args.includes("--fast"),
		contract: go || args.includes("--contract"),
		publish: args.includes("--publish"),
		provenance: args.includes("--provenance"),
		commit: ship || args.includes("--commit"),
		tag: ship || args.includes("--tag"),
		push: ship || args.includes("--push"),
		confirm: valueAfter(args, "--confirm"),
		planFile: valueAfter(args, "--publish-plan") || valueAfter(args, "--plan-file") || DEFAULT_PLAN_FILE,
		skipPublishPlan: args.includes("--skip-publish-plan"),
	};
}

export function readRootVersion(root) {
	return readJsonFile(join(root, "package.json")).version;
}

export function readExpectedTag(root) {
	return expectedSuiteTag({ version: readRootVersion(root) });
}

export function requirePushConfirmation(expectedTag, confirm) {
	if (confirm !== expectedTag) {
		throw new Error(`push requires --confirm ${expectedTag}`);
	}
}

export function releaseCommitMessage(expectedTag) {
	return `chore(release): prepare ${expectedTag}`;
}

export function assertCleanWorkingTree(root) {
	const result = spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });
	const dirty = (result.stdout || "").trim();
	if (dirty) {
		throw new Error(`working tree is not clean — commit or stash first:\n${dirty}`);
	}
}

export function printConfirmation(expectedTag) {
	console.log(`Release confirmation token: ${expectedTag}`);
	console.log(`Ship with:\n  node scripts/release-flow.mjs --ship --confirm ${expectedTag}`);
}

export function runStep(label, command, args, { cwd = ROOT, allowFailure = false, spawn = spawnSync } = {}) {
	console.log(`\n→ ${label}`);
	const result = spawn(command, args, { cwd, encoding: "utf8", stdio: "pipe" });
	const output = `${result.stdout || ""}${result.stderr || ""}`;
	if (output.trim()) process.stdout.write(`${output}${output.endsWith("\n") ? "" : "\n"}`);
	if ((result.status ?? 1) !== 0 && !allowFailure) {
		throw new Error(`${label} failed (exit ${result.status ?? 1})`);
	}
	return { status: result.status ?? 1, output };
}

export function planReleaseFlow(root, opts) {
	const steps = [];
	const dryRun = !(
		opts.go ||
		opts.prepare ||
		opts.write ||
		opts.syncDocs ||
		opts.runTest ||
		opts.contract ||
		opts.publish ||
		opts.commit ||
		opts.tag ||
		opts.push
	);
	if (dryRun) steps.push("publish classification");
	if (opts.prepare || opts.write) {
		steps.push(opts.write ? "release-prepare --write --until-clean" : "release-prepare dry-run");
	}
	if (opts.syncDocs) steps.push("sync:docs:html");
	if (opts.runTest) steps.push(opts.fastTest ? "test:fast" : "npm test");
	if (opts.contract) steps.push("release-contract");
	if (!opts.skipPublishPlan) steps.push("publish-npm verify plan");
	if (opts.publish) steps.push("publish-npm --publish");
	if (opts.commit) steps.push("git commit");
	if (opts.tag) steps.push("git tag");
	if (opts.push) steps.push("git push main + tag");
	return { dryRun, steps, expectedTag: readExpectedTag(root) };
}

function printDryRunGuide(plan) {
	console.log("Release flow dry run.");
	console.log(`Current suite tag: ${plan.expectedTag}`);
	console.log("Planned steps:");
	for (const step of plan.steps) console.log(`  - ${step}`);
	console.log("\nSuggested commands:");
	console.log("  npm run release:go");
	console.log("  node scripts/release-flow.mjs --print-confirmation");
	console.log(`  node scripts/release-flow.mjs --ship --confirm ${plan.expectedTag}`);
}

function classifyPublishPlan(opts) {
	return runStep(
		"publish classification",
		process.execPath,
		[join(ROOT, "scripts", "publish-npm.mjs"), "--plan-file", join(ROOT, opts.planFile)],
		{ allowFailure: true },
	);
}

export function assertVerifiedPublishPlan(result) {
	if (result.output.includes("BUMP?") || result.output.includes("need a version bump.")) {
		const pending = /(\d+) need a version bump/.exec(result.output);
		if (pending && Number(pending[1]) > 0) {
			throw new Error("publish plan still has packages that need a version bump");
		}
	}
	if (result.status !== 0) throw new Error(`publish classification failed (exit ${result.status})`);
	return result;
}

function verifyPublishPlan(opts) {
	return assertVerifiedPublishPlan(classifyPublishPlan(opts));
}

function stageReleaseFiles() {
	runStep("stage release files", "git", ["add", ...RELEASE_STAGE_PATHS, "-u", "extensions"]);
}

function commitRelease(expectedTag) {
	stageReleaseFiles();
	runStep("git commit", "git", ["commit", "-m", releaseCommitMessage(expectedTag)]);
}

function createReleaseTag(expectedTag) {
	runStep("git tag", "git", ["tag", expectedTag]);
}

function pushRelease(expectedTag) {
	runStep("git push main", "git", ["push", "origin", "main"]);
	runStep("git push tag", "git", ["push", "origin", expectedTag]);
}

function main() {
	const opts = parseReleaseFlowOptions(process.argv.slice(2));

	if (opts.printConfirmation) {
		printConfirmation(readExpectedTag(ROOT));
		return;
	}

	const plan = planReleaseFlow(ROOT, opts);

	if (plan.dryRun) {
		printDryRunGuide(plan);
		if (!opts.skipPublishPlan) classifyPublishPlan(opts);
		return;
	}

	if ((opts.go || opts.write) && !opts.allowDirty) assertCleanWorkingTree(ROOT);

	if (!opts.skipPublishPlan && (opts.prepare || opts.write)) classifyPublishPlan(opts);

	if (opts.prepare || opts.write) {
		const prepareArgs = [join(ROOT, "scripts", "release-prepare.mjs")];
		if (opts.write) prepareArgs.push("--write");
		if (opts.untilClean) prepareArgs.push("--until-clean");
		if (existsSync(join(ROOT, opts.planFile))) prepareArgs.push("--publish-plan", opts.planFile);
		runStep("release prepare", process.execPath, prepareArgs);
	}

	const expectedTag = readExpectedTag(ROOT);

	if (opts.syncDocs) runStep("sync docs html", "npm", ["run", "-s", "sync:docs:html"], { cwd: ROOT });
	if (opts.runTest) {
		runStep(opts.fastTest ? "test:fast" : "npm test", "npm", ["run", "-s", opts.fastTest ? "test:fast" : "test"], {
			cwd: ROOT,
		});
	}
	if (opts.contract) {
		runStep("release contract", process.execPath, [
			join(ROOT, "scripts", "release-contract.mjs"),
			"--expect-tag",
			expectedTag,
		]);
	}

	if (!opts.skipPublishPlan) verifyPublishPlan(opts);

	if (opts.publish) {
		const publishArgs = [
			join(ROOT, "scripts", "publish-npm.mjs"),
			"--from-plan",
			join(ROOT, opts.planFile),
			"--publish",
		];
		if (opts.provenance) publishArgs.push("--provenance");
		runStep("publish npm", process.execPath, publishArgs);
	}

	if (opts.push) requirePushConfirmation(expectedTag, opts.confirm);
	if (opts.commit) commitRelease(expectedTag);
	if (opts.tag) createReleaseTag(expectedTag);
	if (opts.push) pushRelease(expectedTag);

	console.log(`\nRelease flow finished for ${expectedTag}.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	try {
		main();
	} catch (err) {
		console.error(err instanceof Error ? err.message : err);
		process.exit(1);
	}
}
