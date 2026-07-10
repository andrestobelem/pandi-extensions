#!/usr/bin/env node

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { runWorkflow } from "../../runtime/runner.mjs";

const enabled = process.env.PANDI_CURSOR_SMOKE === "1";

test("Cursor CLI executes a read-only worker through the portable runner", { skip: !enabled }, async () => {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pandi-cursor-live-smoke-"));
	try {
		const workflows = path.join(cwd, ".cursor", "ultracode", "workflows");
		await fs.mkdir(workflows, { recursive: true });
		await fs.writeFile(
			path.join(workflows, "smoke.js"),
			`const answer = await agent("Respond with exactly PANDI_CURSOR_RUNNER_SMOKE. Do not use tools, commands, files, or markdown.", { label: "smoke" });\nreturn answer;\n`,
			"utf8",
		);
		const outcome = await runWorkflow({
			cwd,
			name: "smoke",
			concurrency: 1,
			maxAgents: 1,
			trustWorkspace: true,
			agentTimeoutMs: 120_000,
		});
		assert.equal(outcome.result.trim(), "PANDI_CURSOR_RUNNER_SMOKE");
	} finally {
		await fs.rm(cwd, { recursive: true, force: true });
	}
});
