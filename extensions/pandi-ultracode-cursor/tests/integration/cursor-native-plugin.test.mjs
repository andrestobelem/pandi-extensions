#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(__dirname, "..", "..");
const PLUGIN_ROOT = path.join(PACKAGE_ROOT, "cursor-plugin");

test("Cursor plugin requires explicit trust without advertising mutating flags", () => {
	const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, ".cursor-plugin", "plugin.json"), "utf8"));
	const command = fs.readFileSync(path.join(PLUGIN_ROOT, "commands", "ultracode.md"), "utf8");
	const skill = fs.readFileSync(path.join(PLUGIN_ROOT, "skills", "ultracode", "SKILL.md"), "utf8");

	assert.equal(manifest.name, "pandi-ultracode");
	assert.match(command, /^name: ultracode$/m);
	assert.match(command, /contract gate/i);
	assert.match(command, /run cursor-ultracode/);
	assert.match(command, /pandi-ultracode-cursor/);
	assert.match(command, /--trust-workspace/);
	assert.doesNotMatch(command, /--allow-agent-write|--allow-workflow-write|--allow-workflow-shell/);
	assert.match(skill, /^name: ultracode$/m);
	assert.match(skill, /disable-model-invocation: true/);
});

test("Cursor plugin and host workflow ship in the npm package", () => {
	const packed = spawnSync("npm", ["pack", "--dry-run", "--json"], {
		cwd: PACKAGE_ROOT,
		encoding: "utf8",
	});
	assert.equal(packed.status, 0, packed.stderr);
	const output = JSON.parse(packed.stdout);
	const manifest = Array.isArray(output) ? output[0] : Object.values(output)[0];
	const files = manifest.files.map((entry) => entry.path);
	assert.ok(files.includes("cursor-plugin/.cursor-plugin/plugin.json"));
	assert.ok(files.includes("cursor-plugin/commands/ultracode.md"));
	assert.ok(files.includes("cursor-plugin/skills/ultracode/SKILL.md"));
	assert.ok(files.includes("workflows/cursor-ultracode.js"));
});
