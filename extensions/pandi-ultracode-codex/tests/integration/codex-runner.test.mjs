#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildCodexCommand, parseCodexStream } from "../../runtime/codex-agent.mjs";
import { normalizeRunLimits, runWorkflow } from "../../runtime/runner.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

async function makeProject(workflowSource) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "pandi-codex-runner-"));
	const workflows = path.join(root, ".codex", "ultracode", "workflows");
	await fs.mkdir(workflows, { recursive: true });
	await fs.writeFile(path.join(workflows, "demo.js"), workflowSource, "utf8");
	return root;
}

async function makeFakeCodex() {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "pandi-fake-codex-"));
	const file = path.join(root, "fake-codex.mjs");
	await fs.writeFile(
		file,
		`import fs from "node:fs";
const log = process.env.FAKE_CODEX_LOG;
const previous = log && fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\\n").filter(Boolean) : [];
if (log) fs.appendFileSync(log, JSON.stringify(process.argv.slice(2)) + "\\n");
const responses = (process.env.FAKE_CODEX_RESPONSES || "hello").split("|");
const result = responses[Math.min(previous.length, responses.length - 1)];
console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: result } }));
console.log(JSON.stringify({ type: "turn.completed" }));
`,
		"utf8",
	);
	return file;
}

test("Codex CLI documents explicit trust and never advertises mutating flags", () => {
	const result = spawnSync(process.execPath, [path.join(packageRoot, "bin", "pandi-ultracode-codex.mjs"), "--help"], {
		encoding: "utf8",
	});
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /--trust-workspace/);
	assert.doesNotMatch(result.stdout, /workspace-write|dangerously|add-dir/);
});

test("Codex CLI refuses run without --trust-workspace", async () => {
	const project = await makeProject(`return "done";`);
	try {
		const result = spawnSync(
			process.execPath,
			[path.join(packageRoot, "bin", "pandi-ultracode-codex.mjs"), "run", "demo", "--cwd", project],
			{ encoding: "utf8" },
		);
		assert.equal(result.status, 1);
		assert.match(result.stderr, /--trust-workspace/i);
	} finally {
		await fs.rm(project, { recursive: true, force: true });
	}
});

test("buildCodexCommand uses read-only exec with no user config", () => {
	const command = buildCodexCommand({
		command: "codex",
		cwd: "/workspace",
		model: "gpt-5.6",
		lastMessageFile: "/run/final.md",
		outputSchemaFile: "/run/schema.json",
	});
	assert.deepEqual(command, {
		command: "codex",
		args: [
			"exec",
			"--cd",
			"/workspace",
			"--sandbox",
			"read-only",
			"--json",
			"--ephemeral",
			"--ignore-user-config",
			"--output-last-message",
			"/run/final.md",
			"--output-schema",
			"/run/schema.json",
			"--model",
			"gpt-5.6",
		],
	});
});

test("parseCodexStream uses the completed agent message only after terminal completion", () => {
	const parsed = parseCodexStream(
		[
			JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "final" } }),
			JSON.stringify({ type: "turn.completed" }),
		].join("\n"),
	);
	assert.deepEqual(parsed, { ok: true, output: "final", sessionId: undefined });
});

test("codex-ultracode turns a single-agent contract into an observable host run", async () => {
	const project = await makeProject("return 'local workflow is not selected';");
	const fakeCodex = await makeFakeCodex();
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
	try {
		const outcome = await runWorkflow({
			cwd: project,
			name: "codex-ultracode",
			input: { request: "Explain the repository" },
			trustWorkspace: true,
			codexCommand: process.execPath,
			codexCommandArgs: [fakeCodex],
			env: {
				...process.env,
				FAKE_CODEX_LOG: log,
				FAKE_CODEX_RESPONSES: [
					contract,
					contract,
					contract,
					contract,
					"Explain the repository concisely.",
					"Repository summary.",
				].join("|"),
			},
		});
		assert.equal(outcome.result.status, "completed");
		assert.equal(outcome.result.output, "Repository summary.");
		assert.equal(outcome.result.contract.improvedTask, "Explain the repository");
		assert.equal((await fs.readFile(log, "utf8")).trim().split("\n").length, 6);
	} finally {
		await fs.rm(project, { recursive: true, force: true });
		await fs.rm(path.dirname(fakeCodex), { recursive: true, force: true });
	}
});

test("runWorkflow requires an explicit workspace trust decision", async () => {
	const project = await makeProject(`return await agent("Explain this repository");`);
	try {
		await assert.rejects(
			runWorkflow({ cwd: project, name: "demo", codexCommand: process.execPath }),
			/--trust-workspace/i,
		);
	} finally {
		await fs.rm(project, { recursive: true, force: true });
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

test("runWorkflow records artifacts and resumes journaled Codex calls", async () => {
	const project = await makeProject(`
const answer = await agent("Return the answer", { label: "answer" });
return { answer };
`);
	const fakeCodex = await makeFakeCodex();
	const log = path.join(project, "fake-calls.jsonl");
	try {
		const first = await runWorkflow({
			cwd: project,
			name: "demo",
			trustWorkspace: true,
			codexCommand: process.execPath,
			codexCommandArgs: [fakeCodex],
			env: { ...process.env, FAKE_CODEX_LOG: log, FAKE_CODEX_RESPONSES: "hello" },
		});
		assert.deepEqual(first.result, { answer: "hello" });
		assert.match(first.runDir, /\.codex\/ultracode\/runs/);
		assert.equal(await fs.stat(path.join(first.runDir, "agents", "0001-answer.md")).then(() => "present"), "present");

		const resumed = await runWorkflow({
			cwd: project,
			name: "demo",
			runDir: first.runDir,
			resume: true,
			trustWorkspace: true,
			codexCommand: process.execPath,
			codexCommandArgs: [fakeCodex],
			env: { ...process.env, FAKE_CODEX_LOG: log, FAKE_CODEX_RESPONSES: "different" },
		});
		assert.deepEqual(resumed.result, first.result);
		assert.equal(resumed.runDir, first.runDir);
		assert.equal((await fs.readFile(log, "utf8")).trim().split("\n").length, 1);
	} finally {
		await fs.rm(project, { recursive: true, force: true });
		await fs.rm(path.dirname(fakeCodex), { recursive: true, force: true });
	}
});

test("runWorkflow rejects mutable and unenforceable workflow capabilities", async () => {
	const project = await makeProject(`
await agent("Unsafe", { tools: ["Bash"] });
await bash("echo never");
return "never";
`);
	try {
		await assert.rejects(
			runWorkflow({ cwd: project, name: "demo", trustWorkspace: true, codexCommand: process.execPath }),
			/does not support per-agent tools|bash\(\) is not supported/i,
		);
	} finally {
		await fs.rm(project, { recursive: true, force: true });
	}
});
