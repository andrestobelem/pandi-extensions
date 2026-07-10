#!/usr/bin/env node

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { buildCursorCommand, parseCursorStream } from "../../runtime/cursor-agent.mjs";
import { runWorkflow } from "../../runtime/runner.mjs";

async function makeProject(workflowSource) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "pandi-cursor-runner-"));
	const workflows = path.join(root, ".cursor", "ultracode", "workflows");
	await fs.mkdir(workflows, { recursive: true });
	await fs.writeFile(path.join(workflows, "demo.js"), workflowSource, "utf8");
	return root;
}

async function makeFakeCursor() {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "pandi-fake-cursor-"));
	const file = path.join(root, "fake-cursor.mjs");
	await fs.writeFile(
		file,
		`import fs from "node:fs";
const log = process.env.FAKE_CURSOR_LOG;
const previous = log && fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\\n").filter(Boolean) : [];
if (log) fs.appendFileSync(log, JSON.stringify(process.argv.slice(2)) + "\\n");
const responses = (process.env.FAKE_CURSOR_RESPONSES || '{"message":"hello"}').split("|");
const result = responses[Math.min(previous.length, responses.length - 1)];
console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: result }] } }));
console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result }));
`,
		"utf8",
	);
	return file;
}

test("buildCursorCommand is read-only by default and forwards an explicit model", () => {
	const command = buildCursorCommand({
		command: "cursor-agent",
		cwd: "/workspace",
		model: "gemini-3.5-flash",
	});
	assert.deepEqual(command, {
		command: "cursor-agent",
		args: [
			"--print",
			"--output-format",
			"stream-json",
			"--mode",
			"ask",
			"--sandbox",
			"enabled",
			"--workspace",
			"/workspace",
			"--model",
			"gemini-3.5-flash",
		],
	});
	assert.deepEqual(
		buildCursorCommand({ command: "cursor-agent", cwd: "/workspace", allowWrite: true, trustWorkspace: true }).args,
		[
			"--print",
			"--output-format",
			"stream-json",
			"--sandbox",
			"disabled",
			"--force",
			"--workspace",
			"/workspace",
			"--trust",
		],
	);
});

test("parseCursorStream uses the terminal result event instead of thinking deltas", () => {
	const parsed = parseCursorStream(
		[
			JSON.stringify({ type: "thinking", subtype: "delta", text: "ignore me" }),
			JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "fallback" }] } }),
			JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "final" }),
		].join("\n"),
	);
	assert.deepEqual(parsed, { ok: true, output: "final", sessionId: undefined });
});

test("runWorkflow validates structured output, retries it, records artifacts, and resumes from its journal", async () => {
	const project = await makeProject(`
export const meta = { name: "demo" };
const answer = await agent("Return the answer", {
	label: "answer",
	schema: {
		type: "object",
		additionalProperties: false,
		required: ["message"],
		properties: { message: { type: "string" } },
	},
	schemaRetries: 1,
});
return { answer };
`);
	const fakeCursor = await makeFakeCursor();
	const log = path.join(project, "fake-calls.jsonl");
	const env = { ...process.env, FAKE_CURSOR_LOG: log, FAKE_CURSOR_RESPONSES: 'not json|{"message":"hello"}' };

	try {
		const first = await runWorkflow({
			cwd: project,
			name: "demo",
			cursorCommand: process.execPath,
			cursorCommandArgs: [fakeCursor],
			env,
		});
		assert.deepEqual(first.result, { answer: { message: "hello" } });
		assert.equal((await fs.readFile(log, "utf8")).trim().split("\n").length, 2);
		assert.equal(
			await fs.stat(path.join(first.runDir, "agents", "0001-answer.stdout.log")).then(() => "present"),
			"present",
		);
		assert.equal(await fs.stat(path.join(first.runDir, "journal.json")).then(() => "present"), "present");

		const resumed = await runWorkflow({
			cwd: project,
			name: "demo",
			runDir: first.runDir,
			resume: true,
			cursorCommand: process.execPath,
			cursorCommandArgs: [fakeCursor],
			env,
		});
		assert.deepEqual(resumed.result, first.result);
		assert.equal((await fs.readFile(log, "utf8")).trim().split("\n").length, 2, "resume must use journaled output");
	} finally {
		await fs.rm(project, { recursive: true, force: true });
		await fs.rm(path.dirname(fakeCursor), { recursive: true, force: true });
	}
});

test("runWorkflow provides portable parallel, pipeline, and race primitives", async () => {
	const project = await makeProject(`
const parallelOutput = await parallel([
	() => agent("parallel one", { label: "parallel-one" }),
	() => agent("parallel two", { label: "parallel-two" }),
]);
const pipelineOutput = await pipeline(
	["first", "second"],
	(item) => agent(\`pipeline \${item}\`, { label: \`pipeline-\${item}\` }),
	{ inFlight: 1 },
);
const raced = await race([
	(signal) => agent("race one", { label: "race-one", signal }),
	(signal) => agent("race two", { label: "race-two", signal }),
]);
const batchOutput = await agents(["batch one", "batch two"], { concurrency: 1, settle: true });
return { parallelOutput, pipelineOutput, batchOutput, race: { status: raced.status, winner: raced.winner }, limits, hasRunContext: Boolean(runId && runDir && cwd) };
`);
	const fakeCursor = await makeFakeCursor();
	const log = path.join(project, "fake-calls.jsonl");
	try {
		const outcome = await runWorkflow({
			cwd: project,
			name: "demo",
			concurrency: 2,
			maxAgents: 8,
			cursorCommand: process.execPath,
			cursorCommandArgs: [fakeCursor],
			env: { ...process.env, FAKE_CURSOR_LOG: log },
		});
		assert.equal(outcome.result.parallelOutput.length, 2);
		assert.equal(outcome.result.pipelineOutput.length, 2);
		assert.equal(outcome.result.batchOutput.length, 2);
		assert.equal(outcome.result.race.status, "won");
		assert.deepEqual(outcome.result.limits, { concurrency: 2, maxAgents: 8 });
		assert.equal(outcome.result.hasRunContext, true);
		assert.equal((await fs.readFile(log, "utf8")).trim().split("\n").length, 8);
	} finally {
		await fs.rm(project, { recursive: true, force: true });
		await fs.rm(path.dirname(fakeCursor), { recursive: true, force: true });
	}
});

test("runWorkflow rejects unrepresentable per-agent host options", async () => {
	const project = await makeProject(`
await agent("Unsupported role", { agentType: "reviewer" });
return "never";
`);
	try {
		await assert.rejects(
			runWorkflow({
				cwd: project,
				name: "demo",
				cursorCommand: process.execPath,
				cursorCommandArgs: [process.execPath],
			}),
			/does not support per-agent agentType/i,
		);
	} finally {
		await fs.rm(project, { recursive: true, force: true });
	}
});

test("runWorkflow rejects per-agent tool grants that Cursor CLI cannot enforce", async () => {
	const project = await makeProject(`
await agent("Unsafe request", { tools: ["bash"] });
return "never";
`);
	try {
		await assert.rejects(
			runWorkflow({
				cwd: project,
				name: "demo",
				cursorCommand: process.execPath,
				cursorCommandArgs: [process.execPath],
			}),
			/does not support per-agent tools/i,
		);
	} finally {
		await fs.rm(project, { recursive: true, force: true });
	}
});
