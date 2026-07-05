import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const CONTRACT = path.join(REPO, "scripts", "release-contract.mjs");
const { checkReleaseContract, expectedSuiteTag, EXPECTED_PEER_RANGES } = await import(pathToFileURL(CONTRACT).href);

test("release contract: root suite version maps to the documented git tag", () => {
	const rootPkg = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8"));
	assert.equal(rootPkg.private, true);
	assert.equal(rootPkg.version, "0.2.0");
	assert.equal(expectedSuiteTag(rootPkg), "v0.2.0");

	const setup = fs.readFileSync(path.join(REPO, "docs", "setup.md"), "utf8");
	assert.match(setup, /pandi-extensions@v0\.2\.0/);
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
		"release tag v9.9.9 does not match root package version tag v0.2.0",
	]);
});
