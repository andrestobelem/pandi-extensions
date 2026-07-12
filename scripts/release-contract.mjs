#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readJsonFile } from "./lib/json-io.mjs";
import { loadPublicWorkspaces } from "./lib/release-workspaces.mjs";

export const EXPECTED_PEER_RANGES = Object.freeze({
	"@earendil-works/pi-ai": "^0.80.3",
	"@earendil-works/pi-coding-agent": "^0.80.3",
	"@earendil-works/pi-tui": "^0.80.3",
	typebox: "^1.1.38",
});

export function expectedSuiteTag(rootPkg) {
	return `v${rootPkg.version}`;
}

export function loadWorkspacePackages(root) {
	return loadPublicWorkspaces(root).map(({ dir, file, pkg }) => ({ dir, file, pkg }));
}

export function isSemverSuiteTag(tag) {
	return /^v\d+\.\d+\.\d+$/.test(tag);
}

export function checkPeerSet(pkg, label) {
	const issues = [];
	const peers = pkg.peerDependencies || {};
	for (const [name, range] of Object.entries(peers)) {
		if (range === "*") issues.push(`${label}: peer ${name} must not use '*'`);
		const expected = EXPECTED_PEER_RANGES[name];
		if (expected && range !== expected) issues.push(`${label}: peer ${name} is ${range}, expected ${expected}`);
	}
	return issues;
}

export function checkRootReleaseMetadata(rootPkg, setup, options = {}) {
	const issues = [];
	const tag = expectedSuiteTag(rootPkg);
	if (!isSemverSuiteTag(tag)) issues.push(`root version ${rootPkg.version} does not map to a semver suite tag`);
	if (options.expectedTag && options.expectedTag !== tag) {
		issues.push(`release tag ${options.expectedTag} does not match root package version tag ${tag}`);
	}
	if (!setup.includes(`pandi-extensions@${tag}`)) issues.push(`docs/setup.md does not reference ${tag}`);
	return issues;
}

export function checkReleaseContract(root, options = {}) {
	const issues = [];
	const rootPkg = readJsonFile(join(root, "package.json"));
	const setup = readFileSync(join(root, "docs", "setup.md"), "utf8");

	issues.push(...checkRootReleaseMetadata(rootPkg, setup, options));
	issues.push(...checkPeerSet(rootPkg, "root package.json"));
	for (const { pkg } of loadWorkspacePackages(root)) {
		issues.push(...checkPeerSet(pkg, pkg.name));
	}
	return issues;
}

export function parseExpectedTag(args) {
	const eq = args.find((a) => a.startsWith("--expect-tag="));
	if (eq) return eq.slice("--expect-tag=".length);
	const idx = args.indexOf("--expect-tag");
	return idx >= 0 ? args[idx + 1] : undefined;
}

function main() {
	const root = fileURLToPath(new URL("..", import.meta.url));
	const issues = checkReleaseContract(root, { expectedTag: parseExpectedTag(process.argv.slice(2)) });
	if (issues.length === 0) {
		console.log("release contract ok");
		return;
	}
	for (const issue of issues) console.error(`release contract: ${issue}`);
	process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
