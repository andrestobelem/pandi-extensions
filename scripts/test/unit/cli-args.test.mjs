import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCheckOnly, parsePositiveInt, valueAfter } from "../../lib/cli-args.mjs";

test("parseCheckOnly detects --check without parsing unrelated flags", () => {
	assert.equal(parseCheckOnly(["--check"]), true);
	assert.equal(parseCheckOnly(["--dest", "tmp"]), false);
});

test("valueAfter reads spaced and equals forms", () => {
	assert.equal(valueAfter(["--plan", "a.json"], "--plan"), "a.json");
	assert.equal(valueAfter(["--plan=b.json"], "--plan"), "b.json");
	assert.equal(valueAfter([], "--plan"), undefined);
});

test("parsePositiveInt accepts integers and rejects invalid values", () => {
	assert.equal(parsePositiveInt(undefined, 5), 5);
	assert.equal(parsePositiveInt("3", 5), 3);
	assert.throws(() => parsePositiveInt("0", 5), /invalid positive integer/);
	assert.throws(() => parsePositiveInt("1.5", 5), /invalid positive integer/);
});
