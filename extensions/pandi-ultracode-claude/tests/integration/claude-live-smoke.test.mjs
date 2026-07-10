#!/usr/bin/env node

import assert from "node:assert/strict";
import test from "node:test";

import { runWorkflow } from "../../runtime/runner.mjs";

test("Claude CLI adapter completes one read-only worker when explicitly enabled", {
	skip: process.env.PANDI_CLAUDE_SMOKE === "1" ? false : "set PANDI_CLAUDE_SMOKE=1 to spend a Claude CLI call",
}, async () => {
	const outcome = await runWorkflow({
		cwd: process.cwd(),
		name: "claude-ultracode",
		input: { request: "Describí en una frase el propósito de este repositorio." },
		concurrency: 1,
		maxAgents: 8,
		trustWorkspace: true,
	});
	assert.equal(outcome.result.status, "completed");
	assert.equal(typeof outcome.result.output, "string");
	assert.ok(outcome.result.output.length > 0);
});
