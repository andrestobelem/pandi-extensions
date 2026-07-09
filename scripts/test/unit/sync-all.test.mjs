import assert from "node:assert/strict";
import { test } from "node:test";
import { planSyncScripts, REPO_LOCAL_SYNC_STEPS, runSyncScripts } from "../../sync-all.mjs";

const writeScripts = [
	"format:claude",
	"sync:manifest",
	"sync:settings",
	"sync:skills",
	"sync:skills:vendor",
	"sync:agents",
	"sync:claude:ultracode",
	"docs:links:check",
	"sync:docs:html",
	"sync:personas",
	"sync:personas:package",
];
const checkScripts = [
	"format:claude:check",
	"sync:manifest:check",
	"sync:settings:check",
	"sync:skills:check",
	"sync:skills:vendor:check",
	"sync:agents:check",
	"sync:claude:ultracode:check",
	"docs:links:check",
	"sync:docs:html:check",
	"sync:personas:check",
	"sync:personas:package:check",
];

test("repo-local sync steps preserve write/check order", () => {
	assert.deepEqual(
		REPO_LOCAL_SYNC_STEPS.map((step) => step.write),
		writeScripts,
	);
	assert.deepEqual(
		REPO_LOCAL_SYNC_STEPS.map((step) => step.check),
		checkScripts,
	);
});

test("planSyncScripts derives write, check, and global plans from one table", () => {
	assert.deepEqual(planSyncScripts(), writeScripts);
	assert.deepEqual(planSyncScripts({ checkOnly: true }), checkScripts);
	assert.deepEqual(planSyncScripts({ includeGlobal: true }), [
		...writeScripts,
		"sync:claude:global",
		...checkScripts,
		"sync:claude:global:check",
	]);
	assert.deepEqual(planSyncScripts({ checkOnly: true, includeGlobal: true }), [
		...checkScripts,
		"sync:claude:global:check",
	]);
});

test("runSyncScripts stops at the first failing npm script", () => {
	const calls = [];
	const result = runSyncScripts(["one", "two", "three"], {
		spawn(command, args) {
			calls.push([command, args]);
			return { status: args.includes("two") ? 7 : 0 };
		},
	});

	assert.equal(result.ok, false);
	assert.equal(result.failedScript, "two");
	assert.equal(result.status, 7);
	assert.deepEqual(calls, [
		["npm", ["run", "-s", "one"]],
		["npm", ["run", "-s", "two"]],
	]);
});
