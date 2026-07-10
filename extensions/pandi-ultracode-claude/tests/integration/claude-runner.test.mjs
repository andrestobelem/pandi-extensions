#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildClaudeCommand, parseClaudeStream } from "../../runtime/claude-agent.mjs";
import { runWorkflow } from "../../runtime/runner.mjs";

async function makeProject(workflowSource) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "pandi-claude-runner-"));
	const workflows = path.join(root, ".claude", "ultracode", "workflows");
	await fs.mkdir(workflows, { recursive: true });
	await fs.writeFile(path.join(workflows, "demo.js"), workflowSource, "utf8");
	return root;
}

async function makeFakeClaude() {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "pandi-fake-claude-"));
	const file = path.join(root, "fake-claude.mjs");
	await fs.writeFile(
		file,
		`import fs from "node:fs";
const log = process.env.FAKE_CLAUDE_LOG;
const previous = log && fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\\n").filter(Boolean) : [];
if (log) fs.appendFileSync(log, JSON.stringify(process.argv.slice(2)) + "\\n");
const responses = (process.env.FAKE_CLAUDE_RESPONSES || "hello").split("|");
const result = responses[Math.min(previous.length, responses.length - 1)];
console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: result }] } }));
console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result }));
`,
		"utf8",
	);
	return file;
}

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

test("Claude CLI documents explicit trust and never advertises mutating flags", () => {
	const result = spawnSync(process.execPath, [path.join(packageRoot, "bin", "pandi-ultracode-claude.mjs"), "--help"], {
		encoding: "utf8",
	});
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /--trust-workspace/);
	assert.doesNotMatch(result.stdout, /allow-agent-write|allow-workflow-write|allow-workflow-shell/);
});

test("buildClaudeCommand uses Claude print mode with a read-only tool allowlist", () => {
	const command = buildClaudeCommand({ command: "claude", cwd: "/workspace", model: "sonnet" });
	assert.deepEqual(command, {
		command: "claude",
		args: [
			"--print",
			"--output-format",
			"stream-json",
			"--permission-mode",
			"plan",
			"--tools",
			"Read,Glob,Grep",
			"--safe-mode",
			"--model",
			"sonnet",
		],
	});
	assert.ok(!command.args.some((arg) => /dangerously|add-dir|plugin-dir|mcp/.test(arg)));
});

test("parseClaudeStream uses the terminal result instead of partial assistant text", () => {
	const parsed = parseClaudeStream(
		[
			JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "partial" }] } }),
			JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "final" }),
		].join("\n"),
	);
	assert.deepEqual(parsed, { ok: true, output: "final", sessionId: undefined });
});

test("claude-ultracode turns a single-agent contract into an observable host run", async () => {
	const project = await makeProject("return 'local workflow is not selected';");
	const fakeClaude = await makeFakeClaude();
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
			name: "claude-ultracode",
			input: { request: "Explain the repository" },
			trustWorkspace: true,
			claudeCommand: process.execPath,
			claudeCommandArgs: [fakeClaude],
			env: {
				...process.env,
				FAKE_CLAUDE_LOG: log,
				FAKE_CLAUDE_RESPONSES: [
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
		await fs.rm(path.dirname(fakeClaude), { recursive: true, force: true });
	}
});

test("runWorkflow requires an explicit workspace trust decision", async () => {
	const project = await makeProject(`return await agent("Explain this repository");`);
	try {
		await assert.rejects(
			runWorkflow({ cwd: project, name: "demo", claudeCommand: process.execPath }),
			/--trust-workspace/i,
		);
	} finally {
		await fs.rm(project, { recursive: true, force: true });
	}
});

test("runWorkflow records artifacts and resumes journaled Claude calls", async () => {
	const project = await makeProject(`
const answer = await agent("Return the answer", { label: "answer" });
return { answer };
`);
	const fakeClaude = await makeFakeClaude();
	const log = path.join(project, "fake-calls.jsonl");
	try {
		const first = await runWorkflow({
			cwd: project,
			name: "demo",
			trustWorkspace: true,
			claudeCommand: process.execPath,
			claudeCommandArgs: [fakeClaude],
			env: { ...process.env, FAKE_CLAUDE_LOG: log, FAKE_CLAUDE_RESPONSES: "hello" },
		});
		assert.deepEqual(first.result, { answer: "hello" });
		assert.match(first.runDir, /\.claude\/ultracode\/runs/);
		assert.equal(await fs.stat(path.join(first.runDir, "agents", "0001-answer.md")).then(() => "present"), "present");

		const resumed = await runWorkflow({
			cwd: project,
			name: "demo",
			runDir: first.runDir,
			resume: true,
			trustWorkspace: true,
			claudeCommand: process.execPath,
			claudeCommandArgs: [fakeClaude],
			env: { ...process.env, FAKE_CLAUDE_LOG: log, FAKE_CLAUDE_RESPONSES: "different" },
		});
		assert.deepEqual(resumed.result, first.result);
		assert.equal((await fs.readFile(log, "utf8")).trim().split("\n").length, 1);
	} finally {
		await fs.rm(project, { recursive: true, force: true });
		await fs.rm(path.dirname(fakeClaude), { recursive: true, force: true });
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
			runWorkflow({ cwd: project, name: "demo", trustWorkspace: true, claudeCommand: process.execPath }),
			/does not support per-agent tools|bash\(\) is not supported/i,
		);
	} finally {
		await fs.rm(project, { recursive: true, force: true });
	}
});
