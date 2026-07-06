import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const CONTRACT = path.join(REPO, "scripts", "release-contract.mjs");
const {
	checkPeerSet,
	checkReleaseContract,
	checkRootReleaseMetadata,
	expectedSuiteTag,
	EXPECTED_PEER_RANGES,
	isSemverSuiteTag,
	parseExpectedTag,
} = await import(pathToFileURL(CONTRACT).href);

test("release contract: root suite version maps to the documented git tag", () => {
	const rootPkg = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8"));
	assert.equal(rootPkg.private, true);
	assert.equal(rootPkg.version, "0.3.1");
	assert.equal(expectedSuiteTag(rootPkg), "v0.3.1");

	const setup = fs.readFileSync(path.join(REPO, "docs", "setup.md"), "utf8");
	assert.match(setup, /pandi-extensions@v0\.3\.1/);
});

test("release contract: peer dependency floors are pinned everywhere", () => {
	assert.deepEqual(EXPECTED_PEER_RANGES, {
		"@earendil-works/pi-ai": "^0.80.3",
		"@earendil-works/pi-coding-agent": "^0.80.3",
		"@earendil-works/pi-tui": "^0.80.3",
		typebox: "^1.1.38",
	});

	const issues = checkReleaseContract(REPO);
	assert.deepEqual(issues, []);
});

test("release contract: explicit tag preflight rejects tag/version drift", () => {
	assert.deepEqual(checkReleaseContract(REPO, { expectedTag: "v9.9.9" }), [
		"release tag v9.9.9 does not match root package version tag v0.3.1",
	]);
});

test("release contract: root metadata checks stay pure and reusable", () => {
	assert.equal(isSemverSuiteTag("v1.2.3"), true);
	assert.equal(isSemverSuiteTag("1.2.3"), false);
	assert.deepEqual(checkRootReleaseMetadata({ version: "1.2.3" }, "install pandi-extensions@v1.2.3"), []);
	assert.deepEqual(checkRootReleaseMetadata({ version: "1.2" }, ""), [
		"root version 1.2 does not map to a semver suite tag",
		"docs/setup.md does not reference v1.2",
	]);
});

test("release contract: peer checks reject wildcard and pinned floor drift", () => {
	assert.deepEqual(
		checkPeerSet(
			{
				peerDependencies: {
					"@earendil-works/pi-ai": "*",
					"@earendil-works/pi-tui": "^0.80.2",
					untracked: "*",
				},
			},
			"pkg",
		),
		[
			"pkg: peer @earendil-works/pi-ai must not use '*'",
			"pkg: peer @earendil-works/pi-ai is *, expected ^0.80.3",
			"pkg: peer @earendil-works/pi-tui is ^0.80.2, expected ^0.80.3",
			"pkg: peer untracked must not use '*'",
		],
	);
});

test("release contract: parseExpectedTag supports both flag spellings", () => {
	assert.equal(parseExpectedTag(["--expect-tag=v1.2.3"]), "v1.2.3");
	assert.equal(parseExpectedTag(["--other", "x", "--expect-tag", "v2.0.0"]), "v2.0.0");
	assert.equal(parseExpectedTag([]), undefined);
});
