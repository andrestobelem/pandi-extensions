#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

test("Codex host workflow and runner ship in the npm package", () => {
	const packed = spawnSync("npm", ["pack", "--dry-run", "--json"], { cwd: packageRoot, encoding: "utf8" });
	assert.equal(packed.status, 0, packed.stderr);
	const output = JSON.parse(packed.stdout);
	const manifest = Array.isArray(output) ? output[0] : Object.values(output)[0];
	const files = manifest.files.map((entry) => entry.path);
	assert.ok(files.includes("bin/pandi-ultracode-codex.mjs"));
	assert.ok(files.includes("runtime/codex-agent.mjs"));
	assert.ok(files.includes("workflows/codex-ultracode.js"));
});
