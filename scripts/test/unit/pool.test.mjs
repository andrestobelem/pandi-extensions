import assert from "node:assert/strict";
import { test } from "node:test";
import { mapPool } from "../../lib/pool.mjs";

test("mapPool: preserves order with bounded concurrency", async () => {
	const seen = [];
	const results = await mapPool([1, 2, 3, 4, 5], 2, async (value) => {
		seen.push(value);
		await new Promise((resolve) => setTimeout(resolve, 5));
		return value * 2;
	});
	assert.deepEqual(results, [2, 4, 6, 8, 10]);
	assert.deepEqual(
		[...seen].sort((a, b) => a - b),
		[1, 2, 3, 4, 5],
	);
});

test("mapPool: empty input returns empty array", async () => {
	assert.deepEqual(await mapPool([], 4, async () => 1), []);
});
