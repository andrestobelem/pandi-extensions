#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { checkWorkflow, listWorkflows, runWorkflow } from "../runtime/runner.mjs";

const HELP = `Usage:
  pandi-ultracode-cursor list [--cwd <dir>]
  pandi-ultracode-cursor check <workflow> [--cwd <dir>]
  pandi-ultracode-cursor run <workflow> [flags]
  pandi-ultracode-cursor resume <run-dir> [flags]
  pandi-ultracode-cursor view <run-dir>
  pandi-ultracode-cursor doctor [--cursor-command <path>]

Run flags:
  --cwd <dir>                 Workspace (default: current directory)
  --input <json>              Workflow input JSON (default: {})
  --input-file <file>         Read workflow input JSON from a file
  --concurrency <n>           Maximum Cursor workers in flight (default: 4)
  --max-agents <n>            Maximum launched Cursor workers (default: 32)
  --model <id>                Explicit Cursor model id
  --effort <level>            Recorded advisory reasoning effort
  --cursor-command <path>     Cursor executable (default: cursor-agent)
  --trust-workspace           Pass Cursor --trust for this workspace
  --allow-agent-write         Allow agents that explicitly request allowWrite
  --allow-workflow-write      Allow workflow writeFile/appendFile
  --allow-workflow-shell      Allow workflow bash()

Safety: Cursor agents use --mode ask and --sandbox enabled by default. Mutating
capabilities require their corresponding explicit flag. Per-agent tools, skills,
extensions and environment grants are rejected because Cursor CLI cannot enforce
them independently per worker.
`;

function fail(message) {
	console.error(`Error: ${message}`);
	process.exitCode = 1;
}

function parse(argv) {
	const [action, ...raw] = argv;
	let positional;
	const flags = {};
	for (let index = 0; index < raw.length; index++) {
		const token = raw[index];
		if (!token.startsWith("--")) {
			if (positional !== undefined) throw new Error(`Unexpected argument: ${token}`);
			positional = token;
			continue;
		}
		const key = token.slice(2);
		if (["trust-workspace", "allow-agent-write", "allow-workflow-write", "allow-workflow-shell"].includes(key)) {
			flags[key] = true;
			continue;
		}
		const value = raw[++index];
		if (value === undefined || value.startsWith("--")) throw new Error(`Flag --${key} needs a value.`);
		flags[key] = value;
	}
	return { action, positional, flags };
}

function numberFlag(flags, name) {
	if (flags[name] === undefined) return undefined;
	const value = Number(flags[name]);
	if (!Number.isFinite(value) || value < 1) throw new Error(`--${name} must be a positive number.`);
	return value;
}

async function inputFor(flags) {
	if (flags.input && flags["input-file"]) throw new Error("Use only one of --input or --input-file.");
	const text = flags["input-file"]
		? await fs.readFile(path.resolve(flags["input-file"]), "utf8")
		: (flags.input ?? "{}");
	try {
		return JSON.parse(text);
	} catch {
		throw new Error("Workflow input must be valid JSON.");
	}
}

function common(flags) {
	return {
		cwd: path.resolve(flags.cwd ?? process.cwd()),
		concurrency: numberFlag(flags, "concurrency"),
		maxAgents: numberFlag(flags, "max-agents"),
		model: flags.model,
		effort: flags.effort,
		cursorCommand: flags["cursor-command"],
		trustWorkspace: flags["trust-workspace"] === true,
		allowAgentWrite: flags["allow-agent-write"] === true,
		allowWorkflowWrite: flags["allow-workflow-write"] === true,
		allowWorkflowShell: flags["allow-workflow-shell"] === true,
	};
}

async function main() {
	const { action, positional, flags } = parse(process.argv.slice(2));
	if (!action || action === "help" || action === "--help" || action === "-h") {
		console.log(HELP);
		return;
	}
	if (action === "list") {
		for (const workflow of await listWorkflows(path.resolve(flags.cwd ?? process.cwd()))) {
			console.log(`${workflow.name}\t${workflow.scope}`);
		}
		return;
	}
	if (action === "check") {
		if (!positional) throw new Error("check requires a workflow name.");
		console.log(JSON.stringify(await checkWorkflow({ cwd: flags.cwd, name: positional }), null, 2));
		return;
	}
	if (action === "run") {
		if (!positional) throw new Error("run requires a workflow name.");
		const outcome = await runWorkflow({ ...common(flags), name: positional, input: await inputFor(flags) });
		console.log(JSON.stringify(outcome, null, 2));
		return;
	}
	if (action === "resume") {
		if (!positional) throw new Error("resume requires a run directory.");
		const runDir = path.resolve(positional);
		const status = JSON.parse(await fs.readFile(path.join(runDir, "status.json"), "utf8"));
		const outcome = await runWorkflow({ ...common(flags), name: status.workflow, runDir, resume: true });
		console.log(JSON.stringify(outcome, null, 2));
		return;
	}
	if (action === "view") {
		if (!positional) throw new Error("view requires a run directory.");
		const runDir = path.resolve(positional);
		const [status, summary] = await Promise.all([
			fs.readFile(path.join(runDir, "status.json"), "utf8"),
			fs.readFile(path.join(runDir, "summary.md"), "utf8").catch(() => "(No summary yet.)\n"),
		]);
		console.log(`${status.trim()}\n\n${summary.trim()}`);
		return;
	}
	if (action === "doctor") {
		const command = flags["cursor-command"] ?? process.env.PANDI_CURSOR_COMMAND ?? "cursor-agent";
		const probe = spawnSync(command, ["--version"], { encoding: "utf8" });
		if (probe.error || probe.status !== 0)
			throw new Error(`Could not run ${command} --version: ${probe.error?.message ?? probe.stderr.trim()}`);
		console.log(`Cursor CLI: ${(probe.stdout || probe.stderr).trim()}`);
		console.log("Output protocol: stream-json (verified by the bundled adapter)");
		return;
	}
	throw new Error(`Unknown command: ${action}`);
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
