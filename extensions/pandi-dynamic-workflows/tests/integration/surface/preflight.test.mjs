#!/usr/bin/env node
/**
 * Regression: workflow launch preflight rejects bad workflows before run creation.
 *
 * Issue #76: dynamic workflows should catch syntax errors, unsupported import/require
 * patterns, and non-JSON-serializable launch input before spending a run dir.
 *
 * Run it:
 *   node extensions/pandi-dynamic-workflows/tests/integration/workflow-preflight.test.mjs
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createChecker } from "../../../../shared/test/harness.mjs";
import { buildDwfExtension } from "../dwf-test-support.mjs";

const { check, counts } = createChecker();

async function buildExtension() {
	return await buildDwfExtension({ name: "pi-dw-preflight" });
}

function makePi() {
	const tools = new Map();
	const commands = new Map();
	const notes = [];
	const pi = {
		registerTool: (def) => tools.set(def.name, def),
		registerCommand: (name, def) => commands.set(name, def),
		registerShortcut: () => {},
		on: () => {},
		appendEntry: () => {},
		sendUserMessage: () => {},
		getThinkingLevel: () => undefined,
		getActiveTools: () => [],
		getAllTools: () => [...tools.values()],
		setActiveTools: () => {},
		exec: async () => ({ code: 0, killed: false, stdout: "", stderr: "" }),
	};
	return { pi, tools, commands, notes };
}

function makeCtx(cwd, mode = "print", notes = []) {
	return {
		mode,
		hasUI: mode !== "print",
		cwd,
		isIdle: () => true,
		isProjectTrusted: () => true,
		getContextUsage: () => undefined,
		ui: {
			theme: { fg: (_c, v) => v, bold: (v) => v },
			notify: (message, type) => notes.push({ message, type }),
			setStatus: () => {},
			setWidget: () => {},
			confirm: async () => true,
			select: async () => undefined,
			editor: async (_title, initial = "") => initial,
			custom: async () => undefined,
			getEditorComponent: () => undefined,
			setEditorComponent: () => {},
		},
		sessionManager: { getEntries: () => [] },
	};
}

async function makeProject() {
	const project = await fs.mkdtemp(path.join(os.tmpdir(), "pi-dw-preflight-"));
	await fs.mkdir(path.join(project, ".pi", "workflows"), { recursive: true });
	return project;
}

async function writeWorkflow(project, name, code) {
	await fs.writeFile(path.join(project, ".pi", "workflows", `${name}.js`), `${code}\n`, "utf8");
}

async function runDirs(project) {
	const root = path.join(project, ".pi", "workflows", "runs");
	try {
		const entries = await fs.readdir(root, { withFileTypes: true });
		return entries
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.sort();
	} catch (err) {
		if (err?.code === "ENOENT") return [];
		throw err;
	}
}

const settle = (promise) =>
	promise.then(
		(value) => ({ ok: true, value }),
		(error) => ({ ok: false, message: String(error?.message ?? error) }),
	);

function hasActionablePreflightError(outcome, workflowName, project) {
	if (outcome.ok) return false;
	const workflowPath = path.join(project, ".pi", "workflows", `${workflowName}.js`);
	return (
		outcome.message.includes("Workflow preflight failed") &&
		outcome.message.includes(workflowPath) &&
		/\bFix:/i.test(outcome.message)
	);
}

async function main() {
	const { url } = await buildExtension();
	const mod = await import(url);
	const ext = mod.default;
	const project = await makeProject();
	const harness = makePi();
	(ext.activate ?? ext)(harness.pi, makeCtx(project, "print", harness.notes));
	const tool = harness.tools.get("dynamic_workflow");

	await writeWorkflow(project, "ok", "export const meta = { name: 'ok' };\nreturn { ok: true, topic: args.topic };");
	const checked = await settle(
		tool.execute(
			"tc-check-ok",
			{ action: "check", name: "ok", input: { topic: "bamboo" } },
			new AbortController().signal,
			undefined,
			makeCtx(project),
		),
	);
	check("check action: valid workflow passes", checked.ok === true, checked.ok ? "" : checked.message);
	check("check action: valid workflow does not create a run", (await runDirs(project)).length === 0);

	const ran = await settle(
		tool.execute(
			"tc-run-ok",
			{ action: "run", name: "ok", input: { topic: "bamboo" }, timeoutMs: 30_000 },
			new AbortController().signal,
			undefined,
			makeCtx(project),
		),
	);
	check(
		"valid workflow: run still succeeds",
		ran.ok === true && ran.value?.details?.result?.ok === true,
		ran.ok ? JSON.stringify(ran.value?.details?.result) : ran.message,
	);

	await fs.rm(path.join(project, ".pi", "workflows", "runs"), { recursive: true, force: true });
	await writeWorkflow(project, "bad-syntax", "const value = ;\nreturn value;");
	const syntax = await settle(
		tool.execute(
			"tc-syntax",
			{ action: "run", name: "bad-syntax", timeoutMs: 30_000 },
			new AbortController().signal,
			undefined,
			makeCtx(project),
		),
	);
	check(
		"syntax error: rejected by preflight",
		hasActionablePreflightError(syntax, "bad-syntax", project),
		syntax.message,
	);
	check(
		"syntax error: no run dir created",
		(await runDirs(project)).length === 0,
		JSON.stringify(await runDirs(project)),
	);

	await writeWorkflow(project, "bad-static-import", "import fs from 'node:fs';\nreturn fs.existsSync(cwd);");
	const staticImport = await settle(
		tool.execute(
			"tc-static-import",
			{ action: "run", name: "bad-static-import", timeoutMs: 30_000 },
			new AbortController().signal,
			undefined,
			makeCtx(project),
		),
	);
	check(
		"static import: rejected by preflight",
		hasActionablePreflightError(staticImport, "bad-static-import", project),
		staticImport.message,
	);
	check(
		"static import: no run dir created",
		(await runDirs(project)).length === 0,
		JSON.stringify(await runDirs(project)),
	);

	await writeWorkflow(project, "bad-require", "const fs = require('node:fs');\nreturn fs.existsSync(cwd);");
	const required = await settle(
		tool.execute(
			"tc-require",
			{ action: "start", name: "bad-require", timeoutMs: 30_000 },
			new AbortController().signal,
			undefined,
			makeCtx(project, "tui"),
		),
	);
	check(
		"require: rejected by preflight before background start",
		hasActionablePreflightError(required, "bad-require", project),
		required.ok ? JSON.stringify(required.value?.details?.status) : required.message,
	);
	check("require: no run dir created", (await runDirs(project)).length === 0, JSON.stringify(await runDirs(project)));

	await writeWorkflow(project, "bad-input", "return { ok: true };");
	const badInput = await settle(
		tool.execute(
			"tc-input",
			{ action: "run", name: "bad-input", input: { items: [() => "not-json"] }, timeoutMs: 30_000 },
			new AbortController().signal,
			undefined,
			makeCtx(project),
		),
	);
	check(
		"non-serializable input: rejected by preflight",
		hasActionablePreflightError(badInput, "bad-input", project),
		badInput.message,
	);
	check(
		"non-serializable input: no run dir created",
		(await runDirs(project)).length === 0,
		JSON.stringify(await runDirs(project)),
	);

	const commandNotes = [];
	const commandCtx = makeCtx(project, "tui", commandNotes);
	await harness.commands.get("workflow")?.handler('check ok {"topic":"bamboo"}', commandCtx);
	check(
		"/workflow check: notifies success",
		commandNotes.some((note) => /preflight passed/i.test(note.message)),
		JSON.stringify(commandNotes),
	);

	console.log(`\nTOTAL: ${counts.passed} passed, ${counts.failed} failed`);
	if (counts.failed) {
		console.log(counts.failures.map((failure) => `- ${failure}`).join("\n"));
		process.exit(1);
	}
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
