#!/usr/bin/env node
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import test from "node:test";
import * as vm from "node:vm";
import { buildDwfExtension, REPO_ROOT } from "../dwf-test-support.mjs";

const SCAFFOLD_PATH = path.join(REPO_ROOT, "extensions", "pandi-dynamic-workflows", "scaffolds", "self-refine.js");
const source = await fs.readFile(SCAFFOLD_PATH, "utf8");
const { url } = await buildDwfExtension({ name: "pi-dwf-self-refine-null-refine" });
const { transformWorkflowCode } = await import(url);
const compiled = transformWorkflowCode(source);

function loadWorkflow({ agent, logs }) {
	const module = { exports: {} };
	const globals = {
		args: { task: "refine this draft", maxRounds: 1 },
		agent,
		workflow: async () => {
			throw new Error("unexpected workflow() call");
		},
		phase: () => {},
		log: (message) => logs.push(String(message)),
	};
	vm.runInContext(compiled, vm.createContext({ module, exports: module.exports, ...globals }), {
		filename: "scaffolds/self-refine.js",
		timeout: 1000,
	});
	return module.exports;
}

test("self-refine keeps the last valid draft and exposes refine=null as a failure", async () => {
	const logs = [];
	const responses = [
		"último draft válido",
		{
			satisfied: false,
			issues: [{ where: "intro", problem: "vague", fix: "make it concrete" }],
		},
		null,
	];
	const workflow = loadWorkflow({ logs, agent: async () => responses.shift() });

	const output = await workflow();

	assert.deepEqual(
		{
			result: output.result,
			failure: output.failure,
			logsReturningLastDraft: logs.some((line) => /refine returned null.*returning last good draft/i.test(line)),
			logsFailedCompletion: logs.some((line) => /self-refine complete.*"failed":true/.test(line)),
		},
		{
			result: "último draft válido",
			failure: "round 1: refine returned null",
			logsReturningLastDraft: true,
			logsFailedCompletion: true,
		},
	);
});
