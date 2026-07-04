import assert from "node:assert/strict";
import { test } from "node:test";
import { classify } from "../../publish-npm.mjs";

test("classify: version not on npm -> publish", () => {
	assert.equal(classify(null, "abc123"), "publish");
});

test("classify: remote shasum matches local -> unchanged", () => {
	assert.equal(classify("abc123", "abc123"), "unchanged");
});

test("classify: remote shasum differs from local -> bump", () => {
	assert.equal(classify("abc123", "def456"), "bump");
});
