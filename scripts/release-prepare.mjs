#!/usr/bin/env node
/**
 * Prepara una release local sin publicar: detecta workspaces que `publish-npm`
 * marca como BUMP?, sube versiones patch y actualiza los archivos que el
 * contrato de release valida. Seguro por defecto: sin `--write` solo muestra el plan.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parsePositiveInt, valueAfter } from "./lib/cli-args.mjs";
import { readJsonFile, writeJsonFile } from "./lib/json-io.mjs";
import { loadPublicWorkspaces } from "./lib/release-workspaces.mjs";
import { parsePublishPlanDocument } from "./publish-npm.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DEFAULT_MAX_ROUNDS = 5;

export function parsePrepareOptions(args) {
	return {
		write: args.includes("--write"),
		untilClean: args.includes("--until-clean"),
		maxRounds: parsePositiveInt(valueAfter(args, "--max-rounds"), DEFAULT_MAX_ROUNDS),
		publishOutputFile: valueAfter(args, "--publish-output"),
		publishPlanFile: valueAfter(args, "--publish-plan"),
	};
}

export function bumpPatch(version) {
	const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(version));
	if (!match) throw new Error(`cannot patch-bump non-semver version: ${version}`);
	return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

function parsePublishPlanLine(line) {
	let match = /^BUMP\?\s+(.+)@(\d+\.\d+\.\d+)\s+\(/.exec(line);
	if (match) return { kind: "bumps", entry: { name: match[1], version: match[2] } };

	match = /^PUBLISH\s+(.+)@(\d+\.\d+\.\d+)\s+\(/.exec(line);
	if (match) return { kind: "publishes", entry: { name: match[1], version: match[2] } };

	match = /^UNCHANGED\s+(.+)@(\d+\.\d+\.\d+)/.exec(line);
	if (match) return { kind: "unchanged", entry: { name: match[1], version: match[2] } };

	return null;
}

export function parsePublishPlan(output) {
	const plan = { bumps: [], publishes: [], unchanged: [] };
	for (const line of String(output).split("\n")) {
		const parsed = parsePublishPlanLine(line);
		if (parsed) plan[parsed.kind].push(parsed.entry);
	}
	return plan;
}

export function publishPlanToLegacyShape(document) {
	const plan = parsePublishPlanDocument(document);
	return {
		bumps: plan.packages.filter((entry) => entry.action === "bump").map(({ name, version }) => ({ name, version })),
		publishes: plan.packages
			.filter((entry) => entry.action === "publish")
			.map(({ name, version }) => ({ name, version })),
		unchanged: plan.packages
			.filter((entry) => entry.action === "unchanged")
			.map(({ name, version }) => ({ name, version })),
	};
}

/** @deprecated Usá loadPublicWorkspaces desde release-workspaces.mjs */
export function loadWorkspacePackages(root) {
	return loadPublicWorkspaces(root).map(({ relDir, file, pkg }) => ({ dir: relDir, file, pkg }));
}

export function planVersionBumps({ rootPkg, workspaces, packageNames, bumpRoot = true }) {
	const wanted = new Set(packageNames);
	const workspaceBumps = workspaces
		.filter(({ pkg }) => wanted.has(pkg.name))
		.map(({ dir, file, pkg }) => ({ dir, file, name: pkg.name, from: pkg.version, to: bumpPatch(pkg.version) }));
	const found = new Set(workspaceBumps.map((bump) => bump.name));
	const missing = [...wanted].filter((name) => !found.has(name));
	if (missing.length > 0) throw new Error(`publish plan referenced unknown workspace(s): ${missing.join(", ")}`);
	return {
		root: bumpRoot
			? { from: rootPkg.version, to: bumpPatch(rootPkg.version) }
			: { from: rootPkg.version, to: rootPkg.version },
		workspaces: workspaceBumps,
	};
}

export function applyVersionBumps(root, plan) {
	const rootFile = join(root, "package.json");
	const rootPkg = readJsonFile(rootFile);
	rootPkg.version = plan.root.to;
	writeJsonFile(rootFile, rootPkg);

	const workspaceVersions = new Map(plan.workspaces.map((bump) => [bump.name, bump.to]));
	const workspaceDirs = new Set(plan.workspaces.map((bump) => bump.dir));
	for (const { relDir: dir, file } of loadPublicWorkspaces(root)) {
		const pkg = readJsonFile(file);
		if (workspaceDirs.has(dir)) pkg.version = workspaceVersions.get(pkg.name);
		updateInternalWorkspaceRanges(pkg, workspaceVersions);
		writeJsonFile(file, pkg);
	}

	const lockFile = join(root, "package-lock.json");
	if (existsSync(lockFile)) {
		const lock = readJsonFile(lockFile);
		lock.version = plan.root.to;
		if (lock.packages?.[""]) lock.packages[""].version = plan.root.to;
		for (const [key, pkg] of Object.entries(lock.packages || {})) {
			if (workspaceDirs.has(key) && workspaceVersions.has(pkg.name)) pkg.version = workspaceVersions.get(pkg.name);
			updateInternalWorkspaceRanges(pkg, workspaceVersions);
		}
		writeJsonFile(lockFile, lock);
	}

	if (plan.root.from !== plan.root.to) updateTagReferences(root, `v${plan.root.from}`, `v${plan.root.to}`);
}

function updateInternalWorkspaceRanges(pkg, workspaceVersions) {
	for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
		for (const [name, version] of workspaceVersions) {
			if (pkg[field]?.[name]) pkg[field][name] = version;
		}
	}
}

export function updateTagReferences(root, oldTag, newTag) {
	for (const rel of ["docs/setup.md", "RELEASING.md"]) {
		const file = join(root, rel);
		if (!existsSync(file)) continue;
		const before = readFileSync(file, "utf8");
		const after = before.split(oldTag).join(newTag);
		if (after !== before) writeFileSync(file, after);
	}
}

export function runPublishDryRun(root, { planFile } = {}) {
	const tempDir = mkdtempSync(join(tmpdir(), "release-prepare-"));
	const targetPlanFile = planFile || join(tempDir, "publish-plan.json");
	const cleanupTemp = !planFile;
	try {
		const result = spawnSync(
			process.execPath,
			[join(root, "scripts", "publish-npm.mjs"), "--plan-file", targetPlanFile, "--json"],
			{ cwd: root, encoding: "utf8" },
		);
		const output = `${result.stdout || ""}${result.stderr || ""}`;
		if (result.error) throw result.error;
		if (result.status !== 0 && !output.includes("BUMP?") && !output.includes('"action": "bump"')) {
			throw new Error(`publish dry-run failed without a version-bump plan:\n${output}`);
		}
		return {
			planFile: targetPlanFile,
			publishPlan: publishPlanToLegacyShape(readFileSync(targetPlanFile, "utf8")),
			exitCode: result.status ?? 0,
		};
	} finally {
		if (cleanupTemp) rmSync(tempDir, { recursive: true, force: true });
	}
}

export function runPrepareRounds(root, options = {}) {
	const {
		write = false,
		untilClean = false,
		maxRounds = DEFAULT_MAX_ROUNDS,
		publishPlanFile,
		publishOutputFile,
		classify = () => runPublishDryRun(root, publishPlanFile ? { planFile: publishPlanFile } : {}),
	} = options;

	let publishPlan;
	if (publishPlanFile) {
		publishPlan = publishPlanToLegacyShape(readFileSync(publishPlanFile, "utf8"));
	} else if (publishOutputFile) {
		publishPlan = parsePublishPlan(readFileSync(publishOutputFile, "utf8"));
	} else {
		publishPlan = classify().publishPlan;
	}

	const rounds = [];
	const limit = untilClean ? maxRounds : 1;
	for (let round = 0; round < limit && publishPlan.bumps.length > 0; round++) {
		const rootPkg = readJsonFile(join(root, "package.json"));
		const plan = planVersionBumps({
			rootPkg,
			workspaces: loadWorkspacePackages(root),
			packageNames: publishPlan.bumps.map((bump) => bump.name),
			bumpRoot: round === 0,
		});
		rounds.push(plan);
		if (write) applyVersionBumps(root, plan);
		if (!untilClean) break;
		publishPlan = classify().publishPlan;
	}

	return {
		rounds,
		remainingBumps: publishPlan.bumps,
		clean: publishPlan.bumps.length === 0,
	};
}

function renderPlan(plan) {
	return [
		`suite ${plan.root.from} -> ${plan.root.to}`,
		...plan.workspaces.map((bump) => `${bump.name} ${bump.from} -> ${bump.to}`),
	].join("\n");
}

function renderRounds(rounds) {
	return rounds.map((plan, index) => `round ${index + 1}\n${renderPlan(plan)}`).join("\n\n");
}

function main() {
	const opts = parsePrepareOptions(process.argv.slice(2));
	const root = ROOT;
	const result = runPrepareRounds(root, {
		write: opts.write,
		untilClean: opts.untilClean,
		maxRounds: opts.maxRounds,
		publishPlanFile: opts.publishPlanFile ? join(root, opts.publishPlanFile) : undefined,
		publishOutputFile: opts.publishOutputFile ? join(root, opts.publishOutputFile) : undefined,
		classify: () =>
			runPublishDryRun(root, {
				planFile: opts.publishPlanFile ? join(root, opts.publishPlanFile) : undefined,
			}),
	});

	if (result.rounds.length === 0) {
		console.log("No BUMP? packages found. Nothing to version-bump.");
		return;
	}

	console.log(renderRounds(result.rounds));
	if (!opts.write) {
		console.log("\nDry run. Re-run with --write to update versions, lockfile and release docs.");
		if (opts.untilClean && result.remainingBumps.length > 0) {
			console.log(`Still pending after simulation: ${result.remainingBumps.map((bump) => bump.name).join(", ")}`);
		}
		return;
	}

	if (opts.untilClean && !result.clean) {
		throw new Error(
			`release prepare stopped with pending BUMP? packages after ${result.rounds.length} round(s): ${result.remainingBumps.map((bump) => bump.name).join(", ")}`,
		);
	}

	const finalTag = `v${readJsonFile(join(root, "package.json")).version}`;
	console.log("\nUpdated release prep files.");
	console.log(`Next checks:\n  npm run release:go\n  npm run release:ship -- --confirm ${finalTag}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	try {
		main();
	} catch (err) {
		console.error(err instanceof Error ? err.message : err);
		process.exit(1);
	}
}
