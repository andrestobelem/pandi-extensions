#!/usr/bin/env node
/**
 * Suite partida de bg-jobs.test.mjs — prune dry-run, --yes, size helpers.
 *
 * Ejecutar: node extensions/pandi-bg/tests/integration/bg-jobs-prune.test.mjs
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { loadModule } from "../../../shared/test/harness.mjs";
import { createBgTestDir, loadExtension, makeCtx, runBgScenarios } from "./bg-test-support.mjs";

async function pruneFlagAndSizeHelpers(url, check) {
	const mod = await loadModule(url);
	const parse = mod.parsePruneFlags;
	const dirSizeBytes = mod.dirSizeBytes;
	check("prune-parse: parsePruneFlags is exported", typeof parse === "function", typeof parse);
	check("prune-size: dirSizeBytes is exported", typeof dirSizeBytes === "function", typeof dirSizeBytes);
	if (typeof parse !== "function" || typeof dirSizeBytes !== "function") return;
	check("prune-parse: --yes enables execution", parse("--yes").yes === true);
	check("prune-parse: absent flag stays dry-run", parse("").yes === false && parse("   ").yes === false);
	check("prune-parse: a typo'd flag is ignored (safe dry-run)", parse("--yse").yes === false);
	check("prune-parse: --yes anywhere in args counts", parse("foo --yes bar").yes === true);
	const dir = await createBgTestDir("pi-bg-size-");
	await fs.writeFile(path.join(dir, "a.log"), "12345");
	await fs.writeFile(path.join(dir, "b.log"), "678");
	const external = path.join(await createBgTestDir("pi-bg-size-ext-"), "big.bin");
	await fs.writeFile(external, "x".repeat(10000));
	await fs.symlink(external, path.join(dir, "link.log"));
	check(
		"prune-size: sums regular files and skips symlinks",
		(await dirSizeBytes(dir)) === 8,
		String(await dirSizeBytes(dir)),
	);
}

async function prunePreviewListsCandidatesWithoutDeleting(url, check) {
	const { commands } = await loadExtension(url);
	const cwd = await createBgTestDir("pi-bg-prune-preview-");
	const runsRoot = path.join(cwd, ".pi", "bg", "runs");
	const seed = async (jobId, status, files = {}) => {
		const dir = path.join(runsRoot, jobId);
		await fs.mkdir(dir, { recursive: true });
		await fs.writeFile(
			path.join(dir, "job.json"),
			JSON.stringify({ jobId, command: jobId, cwd, createdAt: new Date().toISOString() }, null, 2),
		);
		await fs.writeFile(
			path.join(dir, "status.json"),
			JSON.stringify({ jobId, updatedAt: new Date().toISOString(), ...status }, null, 2),
		);
		for (const [name, body] of Object.entries(files)) await fs.writeFile(path.join(dir, name), body);
		return dir;
	};
	const doneDir = await seed("done-1", { state: "completed" }, { "combined.log": "hi" });
	const failDir = await seed("fail-1", { state: "failed" });
	const runDir = await seed("run-1", { state: "running", pid: process.pid });
	const ctx = makeCtx({ cwd, trusted: true });
	await commands.get("bg").handler("prune", ctx);
	const msg = ctx._notes.at(-1)?.msg || "";
	check(
		"prune-preview: deletes nothing on a dry run",
		existsSync(doneDir) && existsSync(failDir) && existsSync(runDir),
		msg,
	);
	check(
		"prune-preview: lists the two terminal jobs as candidates",
		/eliminar done-1/.test(msg) && /eliminar fail-1/.test(msg),
		msg,
	);
	check("prune-preview: skips the alive job with a reason", /omitir\s+run-1/.test(msg), msg);
	check("prune-preview: prompts for --yes", /--yes/.test(msg), msg);
}

async function pruneYesExecutesReDerivesAndAudits(url, check) {
	const { commands } = await loadExtension(url);
	const cwd = await createBgTestDir("pi-bg-prune-yes-");
	const runsRoot = path.join(cwd, ".pi", "bg", "runs");
	const seed = async (jobId, status) => {
		const dir = path.join(runsRoot, jobId);
		await fs.mkdir(dir, { recursive: true });
		await fs.writeFile(
			path.join(dir, "job.json"),
			JSON.stringify({ jobId, command: jobId, cwd, createdAt: new Date().toISOString() }, null, 2),
		);
		await fs.writeFile(
			path.join(dir, "status.json"),
			JSON.stringify({ jobId, updatedAt: new Date().toISOString(), ...status }, null, 2),
		);
		return dir;
	};
	const dead = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
	const doneDir = await seed("done-1", { state: "completed" });
	const deadRunDir = await seed("dead-run", { state: "running", pid: dead.pid });
	const aliveDir = await seed("alive-run", { state: "running", pid: process.pid });
	const ctx = makeCtx({ cwd, trusted: true });
	await commands.get("bg").handler("prune --yes", ctx);
	const msg = ctx._notes.at(-1)?.msg || "";
	check("prune-yes: deletes the completed job", !existsSync(doneDir), msg);
	check("prune-yes: deletes the dead-pid job (reclassified interrupted)", !existsSync(deadRunDir), msg);
	check("prune-yes: skips the alive job", existsSync(aliveDir), msg);
	const audit = (await fs.readFile(path.join(runsRoot, ".audit.jsonl"), "utf8").catch(() => ""))
		.trim()
		.split("\n")
		.filter(Boolean);
	check(
		"prune-yes: one audit line per removal, verb=prune",
		audit.length === 2 && audit.every((l) => /"verb":\s*"prune"/.test(l)),
		JSON.stringify(audit),
	);
	await commands.get("bg").handler("prune --yes", ctx);
	const msg2 = ctx._notes.at(-1)?.msg || "";
	check("prune-yes: a second pass is idempotent (deletes 0)", /Se eliminaron 0 /.test(msg2), msg2);
	check(
		"prune-yes: idempotent pass writes no new audit lines",
		(await fs.readFile(path.join(runsRoot, ".audit.jsonl"), "utf8").catch(() => ""))
			.trim()
			.split("\n")
			.filter(Boolean).length === 2,
	);
}

async function main() {
	await runBgScenarios({
		name: "pi-bg-jobs-prune",
		scenarios: [
			pruneFlagAndSizeHelpers,
			prunePreviewListsCandidatesWithoutDeleting,
			pruneYesExecutesReDerivesAndAudits,
		],
	});
}

main().catch((err) => {
	console.error(err?.stack || err);
	process.exit(1);
});
