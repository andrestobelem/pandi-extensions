#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildCursorCommand, parseCursorStream } from "../../runtime/cursor-agent.mjs";
import { normalizeRunLimits, runWorkflow } from "../../runtime/runner.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

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

test("runWorkflow requires an explicit workspace trust decision", async () => {
	const project = await makeProject(`return await agent("Explain this repository");`);
	try {
		await assert.rejects(
			runWorkflow({ cwd: project, name: "demo", cursorCommand: process.execPath }),
			/--trust-workspace/i,
		);
	} finally {
		await fs.rm(project, { recursive: true, force: true });
	}
});

test("Cursor CLI refuses run without --trust-workspace", async () => {
	const project = await makeProject(`return "done";`);
	try {
		const result = spawnSync(
			process.execPath,
			[path.join(packageRoot, "bin", "pandi-ultracode-cursor.mjs"), "run", "demo", "--cwd", project],
			{ encoding: "utf8" },
		);
		assert.equal(result.status, 1);
		assert.match(result.stderr, /--trust-workspace/i);
	} finally {
		await fs.rm(project, { recursive: true, force: true });
	}
});

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

test("cursor-ultracode turns an explicit task into a contract-gated single-agent run", async () => {
	const project = await makeProject("return 'local workflow is not selected';");
	const fakeCursor = await makeFakeCursor();
	const log = path.join(project, "fake-calls.jsonl");
	const contract = JSON.stringify({
		improvedTask: "Explain the repository",
		successCriteria: ["Return a concise answer"],
		assumptions: [],
		nonGoals: [],
		constraints: ["Read-only"],
		verificationPlan: "Inspect the answer.",
		routingHint: {
			shape: "single-agent",
			pattern: "n/a",
			maxAgents: 1,
			concurrency: "none",
			rationale: "A single answer is enough.",
		},
		ambiguities: [],
	});
	const env = {
		...process.env,
		FAKE_CURSOR_LOG: log,
		FAKE_CURSOR_RESPONSES: [
			contract,
			contract,
			contract,
			contract,
			"Explain the repository concisely.",
			"Repository summary.",
		].join("|"),
	};

	try {
		const outcome = await runWorkflow({
			cwd: project,
			name: "cursor-ultracode",
			input: { request: "Explain the repository" },
			trustWorkspace: true,
			cursorCommand: process.execPath,
			cursorCommandArgs: [fakeCursor],
			env,
		});
		assert.equal(outcome.result.status, "completed");
		assert.equal(outcome.result.output, "Repository summary.");
		assert.equal(outcome.result.contract.improvedTask, "Explain the repository");
		assert.equal((await fs.readFile(log, "utf8")).trim().split("\n").length, 6);
	} finally {
		await fs.rm(project, { recursive: true, force: true });
		await fs.rm(path.dirname(fakeCursor), { recursive: true, force: true });
	}
});

test("cursor-ultracode fans out only after a dynamic-workflow contract", async () => {
	const project = await makeProject("return 'local workflow is not selected';");
	const fakeCursor = await makeFakeCursor();
	const log = path.join(project, "fake-calls.jsonl");
	const contract = JSON.stringify({
		improvedTask: "Audit two files",
		successCriteria: ["Inspect both files"],
		assumptions: [],
		nonGoals: [],
		constraints: ["Read-only"],
		verificationPlan: "Review the synthesis.",
		routingHint: {
			shape: "dynamic-workflow",
			pattern: "fan-out-and-synthesize",
			maxAgents: 4,
			concurrency: "medium",
			rationale: "The files can be inspected independently.",
		},
		ambiguities: [],
	});
	const env = {
		...process.env,
		FAKE_CURSOR_LOG: log,
		FAKE_CURSOR_RESPONSES: [
			contract,
			contract,
			contract,
			contract,
			"Audit the two files.",
			JSON.stringify({
				work: [
					{ title: "first", focus: "Inspect first.md" },
					{ title: "second", focus: "Inspect second.md" },
				],
			}),
			"first evidence",
			"second evidence",
			"Combined evidence.",
		].join("|"),
	};

	try {
		const outcome = await runWorkflow({
			cwd: project,
			name: "cursor-ultracode",
			input: { request: "Audit two files", concurrency: 1 },
			concurrency: 1,
			maxAgents: 10,
			trustWorkspace: true,
			cursorCommand: process.execPath,
			cursorCommandArgs: [fakeCursor],
			env,
		});
		assert.equal(outcome.result.mode, "dynamic-workflow");
		assert.deepEqual(outcome.result.coverage, { completed: 2, total: 2 });
		assert.equal(outcome.result.output, "Combined evidence.");
		assert.equal((await fs.readFile(log, "utf8")).trim().split("\n").length, 9);
	} finally {
		await fs.rm(project, { recursive: true, force: true });
		await fs.rm(path.dirname(fakeCursor), { recursive: true, force: true });
	}
});

test("runWorkflow normalizes finite integer limits within local caps", () => {
	assert.deepEqual(normalizeRunLimits({}), {
		concurrency: 4,
		maxAgents: 32,
		maxWorkflowDepth: 1,
		agentTimeoutMs: 120_000,
	});
	for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, "8"]) {
		assert.deepEqual(
			normalizeRunLimits({
				concurrency: invalid,
				maxAgents: invalid,
				maxWorkflowDepth: invalid,
				agentTimeoutMs: invalid,
			}),
			normalizeRunLimits({}),
		);
	}
	assert.deepEqual(
		normalizeRunLimits({
			concurrency: -1,
			maxAgents: -1,
			maxWorkflowDepth: -1,
			agentTimeoutMs: -1,
		}),
		{
			concurrency: 1,
			maxAgents: 1,
			maxWorkflowDepth: 0,
			agentTimeoutMs: 1,
		},
	);
	assert.deepEqual(
		normalizeRunLimits({
			concurrency: 7.9,
			maxAgents: 42.9,
			maxWorkflowDepth: 3.9,
			agentTimeoutMs: 1_234.9,
		}),
		{
			concurrency: 7,
			maxAgents: 42,
			maxWorkflowDepth: 3,
			agentTimeoutMs: 1_234,
		},
	);
	assert.deepEqual(
		normalizeRunLimits({
			concurrency: 17,
			maxAgents: 1_001,
			maxWorkflowDepth: 33,
			agentTimeoutMs: 3_600_001,
		}),
		{
			concurrency: 16,
			maxAgents: 1_000,
			maxWorkflowDepth: 32,
			agentTimeoutMs: 3_600_000,
		},
	);
});

test("runWorkflow gives concurrent fresh runs unique default directories in the same millisecond", async () => {
	const project = await makeProject(`return "done";`);
	const NativeDate = Date;
	const fixedTime = new NativeDate("2026-07-11T17:23:45.678Z");
	globalThis.Date = class extends NativeDate {
		constructor(...args) {
			super(...(args.length ? args : [fixedTime]));
		}

		static now() {
			return fixedTime.getTime();
		}
	};
	try {
		const [first, second] = await Promise.all([
			runWorkflow({ cwd: project, name: "demo", trustWorkspace: true }),
			runWorkflow({ cwd: project, name: "demo", trustWorkspace: true }),
		]);
		assert.notEqual(first.runDir, second.runDir);
		assert.equal(path.basename(first.runDir).startsWith("2026-07-11T17-23-45-678Z-demo-"), true);
		assert.equal(path.basename(second.runDir).startsWith("2026-07-11T17-23-45-678Z-demo-"), true);
	} finally {
		globalThis.Date = NativeDate;
		await fs.rm(project, { recursive: true, force: true });
	}
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
			trustWorkspace: true,
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
			trustWorkspace: true,
			cursorCommand: process.execPath,
			cursorCommandArgs: [fakeCursor],
			env,
		});
		assert.deepEqual(resumed.result, first.result);
		assert.equal(resumed.runDir, first.runDir);
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
			trustWorkspace: true,
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
		const logLines = (await fs.readFile(log, "utf8")).trim().split("\n").filter(Boolean);
		assert.ok(
			logLines.length >= 7 && logLines.length <= 8,
			`expected 7-8 Cursor invocations, got ${logLines.length}`,
		);
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
				trustWorkspace: true,
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
				trustWorkspace: true,
				cursorCommand: process.execPath,
				cursorCommandArgs: [process.execPath],
			}),
			/does not support per-agent tools/i,
		);
	} finally {
		await fs.rm(project, { recursive: true, force: true });
	}
});
