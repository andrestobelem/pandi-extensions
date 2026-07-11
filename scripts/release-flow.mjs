#!/usr/bin/env node
/**
 * Orquesta el preflight de release de pandi-extensions. Dry-run por defecto.
 *
 * Uso:
 *   node scripts/release-flow.mjs
 *   node scripts/release-flow.mjs --prepare --write --sync-docs --test --contract
 *   node scripts/release-flow.mjs --publish-plan .release-plan.json --contract --publish
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expectedSuiteTag } from "./release-contract.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DEFAULT_PLAN_FILE = ".release-plan.json";

export function parseReleaseFlowOptions(args) {
	return {
		prepare: args.includes("--prepare"),
		write: args.includes("--write"),
		syncDocs: args.includes("--sync-docs"),
		runTest: args.includes("--test"),
		contract: args.includes("--contract"),
		publish: args.includes("--publish"),
		provenance: args.includes("--provenance"),
		planFile: valueAfter(args, "--publish-plan") || valueAfter(args, "--plan-file") || DEFAULT_PLAN_FILE,
		skipPublishPlan: args.includes("--skip-publish-plan"),
	};
}

function valueAfter(args, flag) {
	const eq = args.find((arg) => arg.startsWith(`${flag}=`));
	if (eq) return eq.slice(flag.length + 1);
	const i = args.indexOf(flag);
	return i >= 0 ? args[i + 1] : undefined;
}

function readRootVersion(root) {
	return JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
}

function runStep(label, command, args, { cwd = ROOT, allowFailure = false } = {}) {
	console.log(`\n→ ${label}`);
	const result = spawnSync(command, args, { cwd, encoding: "utf8", stdio: "pipe" });
	const output = `${result.stdout || ""}${result.stderr || ""}`;
	if (output.trim()) process.stdout.write(`${output}${output.endsWith("\n") ? "" : "\n"}`);
	if ((result.status ?? 1) !== 0 && !allowFailure) {
		throw new Error(`${label} failed (exit ${result.status ?? 1})`);
	}
	return { status: result.status ?? 1, output };
}

export function planReleaseFlow(root, opts) {
	const steps = [];
	const dryRun = !(opts.prepare || opts.write || opts.syncDocs || opts.runTest || opts.contract || opts.publish);
	if (dryRun) {
		steps.push("simulate publish classification and show recommended commands");
	}
	if (opts.prepare) steps.push(opts.write ? "release-prepare --write" : "release-prepare dry-run");
	if (opts.syncDocs) steps.push("sync:docs:html");
	if (opts.runTest) steps.push("npm test");
	if (opts.contract)
		steps.push(`release-contract --expect-tag ${expectedSuiteTag({ version: readRootVersion(root) })}`);
	if (!opts.skipPublishPlan) steps.push(`publish-npm --plan-file ${opts.planFile}`);
	if (opts.publish) steps.push("publish-npm --from-plan --publish");
	return { dryRun, steps, expectedTag: expectedSuiteTag({ version: readRootVersion(root) }) };
}

function printDryRunGuide(plan) {
	console.log("Release flow dry run.");
	console.log(`Expected suite tag: ${plan.expectedTag}`);
	console.log("Planned steps:");
	for (const step of plan.steps) console.log(`  - ${step}`);
	console.log("\nSuggested commands:");
	console.log("  node scripts/release-flow.mjs --prepare --write --sync-docs --test --contract");
	console.log(`  git commit -am "chore(release): prepare ${plan.expectedTag}"`);
	console.log(`  git tag ${plan.expectedTag} && git push origin ${plan.expectedTag}`);
}

function main() {
	const opts = parseReleaseFlowOptions(process.argv.slice(2));
	const plan = planReleaseFlow(ROOT, opts);
	if (plan.dryRun) {
		printDryRunGuide(plan);
		if (!opts.skipPublishPlan) {
			runStep("publish classification", process.execPath, [
				join(ROOT, "scripts", "publish-npm.mjs"),
				"--plan-file",
				join(ROOT, opts.planFile),
			]);
		}
		return;
	}

	if (opts.prepare) {
		const prepareArgs = [join(ROOT, "scripts", "release-prepare.mjs")];
		if (opts.write) prepareArgs.push("--write");
		if (existsSync(join(ROOT, opts.planFile))) prepareArgs.push("--publish-plan", join(ROOT, opts.planFile));
		runStep("release prepare", process.execPath, prepareArgs);
	}

	if (opts.syncDocs) runStep("sync docs html", "npm", ["run", "-s", "sync:docs:html"], { cwd: ROOT });
	if (opts.runTest) runStep("npm test", "npm", ["test"], { cwd: ROOT });
	if (opts.contract) {
		runStep("release contract", process.execPath, [
			join(ROOT, "scripts", "release-contract.mjs"),
			"--expect-tag",
			plan.expectedTag,
		]);
	}

	if (!opts.skipPublishPlan && !opts.publish) {
		runStep(
			"publish dry run",
			process.execPath,
			[join(ROOT, "scripts", "publish-npm.mjs"), "--plan-file", join(ROOT, opts.planFile)],
			{ allowFailure: true },
		);
	}

	if (opts.publish) {
		const publishArgs = [
			join(ROOT, "scripts", "publish-npm.mjs"),
			"--from-plan",
			join(ROOT, opts.planFile),
			"--publish",
		];
		if (opts.provenance) publishArgs.push("--provenance");
		runStep("publish npm", process.execPath, publishArgs, { allowFailure: true });
	}

	console.log("\nRelease flow finished.");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	try {
		main();
	} catch (err) {
		console.error(err instanceof Error ? err.message : err);
		process.exit(1);
	}
}
