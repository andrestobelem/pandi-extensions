#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, "..", "..");
const pluginRoot = path.join(packageRoot, "claude-plugin");

test("Claude plugin exposes /ultracode-run without shadowing native /ultracode", () => {
	const manifest = JSON.parse(fs.readFileSync(path.join(pluginRoot, ".claude-plugin", "plugin.json"), "utf8"));
	const command = fs.readFileSync(path.join(pluginRoot, "commands", "ultracode-run.md"), "utf8");

	assert.equal(manifest.name, "pandi-ultracode-claude");
	assert.match(command, /pandi-ultracode-claude/);
	assert.match(command, /trust-workspace/i);
	assert.match(command, /run claude-ultracode/);
	assert.doesNotMatch(command, /^name:\s*ultracode$/m);
	assert.doesNotMatch(command, /allow-agent-write|allow-workflow-write|allow-workflow-shell|dangerously/i);
});

test("Claude plugin and host workflow ship in the npm package", () => {
	const packed = spawnSync("npm", ["pack", "--dry-run", "--json"], { cwd: packageRoot, encoding: "utf8" });
	assert.equal(packed.status, 0, packed.stderr);
	const output = JSON.parse(packed.stdout);
	const manifest = Array.isArray(output) ? output[0] : Object.values(output)[0];
	const files = manifest.files.map((entry) => entry.path);
	assert.ok(files.includes("claude-plugin/.claude-plugin/plugin.json"));
	assert.ok(files.includes("claude-plugin/commands/ultracode-run.md"));
	assert.ok(files.includes("workflows/claude-ultracode.js"));
});
