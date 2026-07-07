#!/usr/bin/env node
/**
 * Prepara una release local sin publicar: detecta workspaces que `publish-npm`
 * marca como BUMP?, sube versiones patch y actualiza los archivos que el
 * contrato de release valida. Seguro por defecto: sin `--write` solo muestra el plan.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

export function parsePrepareOptions(args) {
	return {
		write: args.includes("--write"),
		publishOutputFile: valueAfter(args, "--publish-output"),
	};
}

function valueAfter(args, flag) {
	const eq = args.find((arg) => arg.startsWith(`${flag}=`));
	if (eq) return eq.slice(flag.length + 1);
	const i = args.indexOf(flag);
	return i >= 0 ? args[i + 1] : undefined;
}

export function bumpPatch(version) {
	const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(version));
	if (!match) throw new Error(`cannot patch-bump non-semver version: ${version}`);
	return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

export function parsePublishPlan(output) {
	const bumps = [];
	const publishes = [];
	const unchanged = [];
	for (const line of String(output).split("\n")) {
		let match = /^BUMP\?\s+(.+)@(\d+\.\d+\.\d+)\s+\(/.exec(line);
		if (match) {
			bumps.push({ name: match[1], version: match[2] });
			continue;
		}
		match = /^PUBLISH\s+(.+)@(\d+\.\d+\.\d+)\s+\(/.exec(line);
		if (match) {
			publishes.push({ name: match[1], version: match[2] });
			continue;
		}
		match = /^UNCHANGED\s+(.+)@(\d+\.\d+\.\d+)/.exec(line);
		if (match) unchanged.push({ name: match[1], version: match[2] });
	}
	return { bumps, publishes, unchanged };
}

export function loadWorkspacePackages(root) {
	const extDir = join(root, "extensions");
	return readdirSync(extDir)
		.filter((dir) => dir === "pandi" || dir.startsWith("pandi-"))
		.map((dir) => {
			const file = join(extDir, dir, "package.json");
			if (!existsSync(file)) return null;
			try {
				return { dir: join("extensions", dir), file, pkg: JSON.parse(readFileSync(file, "utf8")) };
			} catch {
				return null;
			}
		})
		.filter((entry) => entry?.pkg?.name && !entry.pkg.private);
}

export function planVersionBumps({ rootPkg, workspaces, packageNames }) {
	const wanted = new Set(packageNames);
	const workspaceBumps = workspaces
		.filter(({ pkg }) => wanted.has(pkg.name))
		.map(({ dir, file, pkg }) => ({ dir, file, name: pkg.name, from: pkg.version, to: bumpPatch(pkg.version) }));
	const found = new Set(workspaceBumps.map((bump) => bump.name));
	const missing = [...wanted].filter((name) => !found.has(name));
	if (missing.length > 0) throw new Error(`publish plan referenced unknown workspace(s): ${missing.join(", ")}`);
	return {
		root: { from: rootPkg.version, to: bumpPatch(rootPkg.version) },
		workspaces: workspaceBumps,
	};
}

function readJson(file) {
	return JSON.parse(readFileSync(file, "utf8"));
}

function writeJson(file, value) {
	writeFileSync(file, `${JSON.stringify(value, null, "\t")}\n`);
}

export function applyVersionBumps(root, plan) {
	const rootFile = join(root, "package.json");
	const rootPkg = readJson(rootFile);
	rootPkg.version = plan.root.to;
	writeJson(rootFile, rootPkg);

	for (const bump of plan.workspaces) {
		const pkg = readJson(join(root, bump.dir, "package.json"));
		pkg.version = bump.to;
		writeJson(join(root, bump.dir, "package.json"), pkg);
	}

	const lockFile = join(root, "package-lock.json");
	if (existsSync(lockFile)) {
		const lock = readJson(lockFile);
		lock.version = plan.root.to;
		if (lock.packages?.[""]) lock.packages[""].version = plan.root.to;
		for (const bump of plan.workspaces) {
			if (lock.packages?.[bump.dir]) lock.packages[bump.dir].version = bump.to;
		}
		writeJson(lockFile, lock);
	}

	updateTagReferences(root, `v${plan.root.from}`, `v${plan.root.to}`);
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

function runPublishDryRun(root) {
	const result = spawnSync(process.execPath, [join(root, "scripts", "publish-npm.mjs")], {
		cwd: root,
		encoding: "utf8",
	});
	const output = `${result.stdout || ""}${result.stderr || ""}`;
	if (result.error) throw result.error;
	if (result.status !== 0 && !output.includes("BUMP?")) {
		throw new Error(`publish dry-run failed without a version-bump plan:\n${output}`);
	}
	return output;
}

function renderPlan(plan) {
	return [
		`suite ${plan.root.from} -> ${plan.root.to}`,
		...plan.workspaces.map((bump) => `${bump.name} ${bump.from} -> ${bump.to}`),
	].join("\n");
}

function main() {
	const opts = parsePrepareOptions(process.argv.slice(2));
	const root = ROOT;
	const publishOutput = opts.publishOutputFile ? readFileSync(opts.publishOutputFile, "utf8") : runPublishDryRun(root);
	const publishPlan = parsePublishPlan(publishOutput);
	if (publishPlan.bumps.length === 0) {
		console.log("No BUMP? packages found. Nothing to version-bump.");
		return;
	}

	const rootPkg = readJson(join(root, "package.json"));
	const workspaces = loadWorkspacePackages(root);
	const plan = planVersionBumps({
		rootPkg,
		workspaces,
		packageNames: publishPlan.bumps.map((bump) => bump.name),
	});

	console.log(renderPlan(plan));
	if (!opts.write) {
		console.log("\nDry run. Re-run with --write to update versions, lockfile and release docs.");
		return;
	}

	applyVersionBumps(root, plan);
	console.log("\nUpdated release prep files.");
	console.log(
		`Next checks:\n  npm run sync:docs:html\n  npm test\n  node scripts/release-contract.mjs --expect-tag v${plan.root.to}\n  npm run publish:npm`,
	);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	main();
}
