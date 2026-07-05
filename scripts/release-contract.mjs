#!/usr/bin/env node
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const EXPECTED_PEER_RANGES = Object.freeze({
	"@earendil-works/pi-ai": "^0.80.3",
	"@earendil-works/pi-coding-agent": "^0.80.3",
	"@earendil-works/pi-tui": "^0.80.3",
	typebox: "^1.1.38",
});

export function expectedSuiteTag(rootPkg) {
	return `v${rootPkg.version}`;
}

function readJson(file) {
	return JSON.parse(readFileSync(file, "utf8"));
}

export function loadWorkspacePackages(root) {
	const extDir = join(root, "extensions");
	return readdirSync(extDir)
		.filter((name) => name === "pandi" || name.startsWith("pandi-"))
		.sort()
		.map((name) => ({ dir: join(extDir, name), file: join(extDir, name, "package.json") }))
		.map(({ dir, file }) => ({ dir, file, pkg: readJson(file) }))
		.filter(({ pkg }) => !pkg.private);
}

function checkPeerSet(pkg, label) {
	const issues = [];
	const peers = pkg.peerDependencies || {};
	for (const [name, range] of Object.entries(peers)) {
		if (range === "*") issues.push(`${label}: peer ${name} must not use '*'`);
		const expected = EXPECTED_PEER_RANGES[name];
		if (expected && range !== expected) issues.push(`${label}: peer ${name} is ${range}, expected ${expected}`);
	}
	return issues;
}

export function checkReleaseContract(root) {
	const issues = [];
	const rootPkg = readJson(join(root, "package.json"));
	const tag = expectedSuiteTag(rootPkg);
	const setup = readFileSync(join(root, "docs", "setup.md"), "utf8");

	if (!/^v\d+\.\d+\.\d+$/.test(tag)) issues.push(`root version ${rootPkg.version} does not map to a semver suite tag`);
	if (!setup.includes(`pandi-extensions@${tag}`)) issues.push(`docs/setup.md does not reference ${tag}`);

	issues.push(...checkPeerSet(rootPkg, "root package.json"));
	for (const { pkg } of loadWorkspacePackages(root)) {
		issues.push(...checkPeerSet(pkg, pkg.name));
	}
	return issues;
}

function main() {
	const root = fileURLToPath(new URL("..", import.meta.url));
	const issues = checkReleaseContract(root);
	if (issues.length === 0) {
		console.log("release contract ok");
		return;
	}
	for (const issue of issues) console.error(`release contract: ${issue}`);
	process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
