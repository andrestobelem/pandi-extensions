#!/usr/bin/env node
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import test from "node:test";
import * as vm from "node:vm";
import { buildDwfExtension, REPO_ROOT } from "../dwf-test-support.mjs";

const SELF_PATH = ".pi/workflows/continuous-improvement.js";
const VERSIONS_DIR = ".pi/workflows/versions";
const WORKFLOW_PATH = path.join(REPO_ROOT, SELF_PATH);

const source = await fs.readFile(WORKFLOW_PATH, "utf8");
const { url } = await buildDwfExtension({ name: "pi-dwf-continuous-improvement-backup" });
const { transformWorkflowCode } = await import(url);
const compiled = transformWorkflowCode(source);

function deferred() {
	let resolve;
	const promise = new Promise((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function makeState(versions, { pauseFirstBackup = false } = {}) {
	const files = new Map([[SELF_PATH, source]]);
	for (const version of versions)
		files.set(`${VERSIONS_DIR}/continuous-improvement.v${version}.js`, `source-v${version}`);
	return {
		files,
		pauseFirstBackup,
		contender: deferred(),
		lockHeld: false,
		lockAttempts: 0,
		backupWrites: [],
		changelogAppends: [],
	};
}

function makeRuntime(state, runId) {
	let agentCall = 0;
	const globals = {
		args: JSON.stringify({ task: "exercise backup guard", maxRounds: 1 }),
		runId,
		log: () => {},
		phase: () => {},
		agent: async () => {
			agentCall += 1;
			if (agentCall === 1) return "draft";
			if (agentCall === 2) return { satisfied: true, issues: [] };
			return {
				changed: true,
				rationale: `rationale-${runId}`,
				changelog: `change-${runId}`,
				source,
			};
		},
		agents: async () => {
			throw new Error("unexpected agents() call");
		},
		readFile: async (file) => {
			if (!state.files.has(file)) throw new Error(`ENOENT: ${file}`);
			return state.files.get(file);
		},
		listFiles: async (dir) => [...state.files.keys()].filter((file) => file.startsWith(`${dir}/`)),
		writeArtifact: async () => {},
		writeFile: async (file, data) => {
			const backup = /continuous-improvement\.v(\d+)\.js$/.exec(file);
			if (backup) {
				state.backupWrites.push(file);
				if (state.pauseFirstBackup && state.backupWrites.length === 1) await state.contender.promise;
				else if (state.pauseFirstBackup) state.contender.resolve();
			}
			state.files.set(file, data);
			return { path: file };
		},
		appendFile: async (file, data) => {
			state.changelogAppends.push(data);
			state.files.set(file, `${state.files.get(file) ?? ""}${data}`);
			return { path: file };
		},
		bash: async (command) => {
			if (command.includes("node --check")) return { ok: true, code: 0, stdout: "", stderr: "" };
			if (command.includes("mkdir") && command.includes("continuous-improvement.lock")) {
				state.lockAttempts += 1;
				if (state.lockHeld) {
					state.contender.resolve();
					return { ok: false, code: 17, stdout: "", stderr: "File exists" };
				}
				state.lockHeld = true;
				return { ok: true, code: 0, stdout: "", stderr: "" };
			}
			if (command.includes("rmdir") && command.includes("continuous-improvement.lock")) {
				state.lockHeld = false;
				return { ok: true, code: 0, stdout: "", stderr: "" };
			}
			throw new Error(`unexpected bash command: ${command}`);
		},
	};
	const module = { exports: {} };
	vm.runInContext(compiled, vm.createContext({ module, exports: module.exports, ...globals }), {
		filename: SELF_PATH,
		timeout: 1000,
	});
	return module.exports;
}

test("backup numbering uses max(vN) + 1 across gaps", async () => {
	const state = makeState([1, 3]);
	const result = await makeRuntime(state, "gap-run")();

	assert.equal(result.meta.backup, `${VERSIONS_DIR}/continuous-improvement.v4.js`);
	assert.equal(state.files.get(`${VERSIONS_DIR}/continuous-improvement.v3.js`), "source-v3");
	assert.equal(state.files.get(`${VERSIONS_DIR}/continuous-improvement.v4.js`), source);
});

test("concurrent applications cannot share a backup or misalign changelog", async () => {
	const state = makeState([1, 3], { pauseFirstBackup: true });
	const settled = await Promise.allSettled([
		makeRuntime(state, "concurrent-a")(),
		makeRuntime(state, "concurrent-b")(),
	]);
	const rejected = settled.filter((result) => result.status === "rejected");

	assert.ok(state.lockAttempts >= 2, "concurrent runs did not contend on an exclusive lock");
	assert.equal(new Set(state.backupWrites).size, state.backupWrites.length, "two runs wrote the same backup");
	assert.ok(
		rejected.length === 0 || rejected.every((result) => String(result.reason).includes("EEXIST")),
		"lock rejection must report EEXIST explicitly",
	);
	const backupVersions = state.backupWrites
		.map((file) => Number(/\.v(\d+)\.js$/.exec(file)?.[1]))
		.sort((a, b) => a - b);
	const changelogVersions = state.changelogAppends
		.map((entry) => Number(/^## v(\d+)/m.exec(entry)?.[1]))
		.sort((a, b) => a - b);
	assert.deepEqual(changelogVersions, backupVersions, "changelog versions diverged from reserved backups");
});
