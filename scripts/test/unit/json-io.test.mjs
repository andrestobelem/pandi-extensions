import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readJsonFile, sameJson, writeJsonFile } from "../../lib/json-io.mjs";

test("readJsonFile returns fallback when the file is missing", () => {
	const dir = mkdtempSync(join(tmpdir(), "json-io-"));
	try {
		const missing = join(dir, "missing.json");
		assert.deepEqual(readJsonFile(missing, { fallback: { ok: true } }), { ok: true });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("writeJsonFile and readJsonFile round-trip tab-indented JSON", () => {
	const dir = mkdtempSync(join(tmpdir(), "json-io-"));
	try {
		const file = join(dir, "pkg.json");
		writeJsonFile(file, { name: "demo", version: "1.0.0" });
		assert.deepEqual(readJsonFile(file), { name: "demo", version: "1.0.0" });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("readJsonFile returns null on parse errors when configured", () => {
	const dir = mkdtempSync(join(tmpdir(), "json-io-"));
	try {
		const file = join(dir, "broken.json");
		writeFileSync(file, "{not-json", "utf8");
		assert.equal(readJsonFile(file, { onError: "null" }), null);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("sameJson compares serialized JSON values", () => {
	assert.equal(sameJson({ a: 1 }, { a: 1 }), true);
	assert.equal(sameJson({ a: 1 }, { a: 2 }), false);
});
