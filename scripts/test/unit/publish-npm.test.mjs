import assert from "node:assert/strict";
import { test } from "node:test";
import { buildPublishArgs, classify, withSafeNpmConfig } from "../../publish-npm.mjs";

test("classify: version not on npm -> publish", () => {
	assert.equal(classify(null, "abc123"), "publish");
});

test("classify: remote shasum matches local -> unchanged", () => {
	assert.equal(classify("abc123", "abc123"), "unchanged");
});

test("classify: remote shasum differs from local -> bump", () => {
	assert.equal(classify("abc123", "def456"), "bump");
});

test("withSafeNpmConfig: registry commands ignore local min-release-age", () => {
	assert.deepEqual(withSafeNpmConfig(["view", "pkg", "version"]), ["view", "pkg", "version", "--min-release-age=0"]);
});

test("buildPublishArgs: public latest publish with safe npm config", () => {
	assert.deepEqual(buildPublishArgs({}), ["publish", "--access", "public", "--tag", "latest", "--min-release-age=0"]);
});

test("buildPublishArgs: optional provenance and otp", () => {
	assert.deepEqual(buildPublishArgs({ provenance: true, otp: "123456", tag: "next" }), [
		"publish",
		"--access",
		"public",
		"--tag",
		"next",
		"--provenance",
		"--otp=123456",
		"--min-release-age=0",
	]);
});
