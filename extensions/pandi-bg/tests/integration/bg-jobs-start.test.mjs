#!/usr/bin/env node
/**
 * Suite partida de bg-jobs.test.mjs — start/completion, argv, mode gates.
 *
 * Ejecutar: node extensions/pandi-bg/tests/integration/bg-jobs-start.test.mjs
 */

import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	createBgTestDir,
	loadExtension,
	makeCtx,
	parseJobId,
	readJson,
	runBgScenarios,
	shellQuote,
	startControlledJob,
	waitFor,
	waitForFile,
} from "./bg-test-support.mjs";

async function realStartCompletesAndLogs(url, check) {
	const { commands, tools } = await loadExtension(url);
	const cwd = await createBgTestDir("pi-bg-real-start-");
	const job = await startControlledJob(commands, cwd, { check });
	check("start: registers no LLM tools", tools.size === 0, `tools=${[...tools.keys()].join(",")}`);
	check("start: artifacts directory exists immediately", existsSync(job.runDir), job.runDir);
	check("start: job.json exists immediately", existsSync(path.join(job.runDir, "job.json")));
	check("start: status.json exists immediately", existsSync(path.join(job.runDir, "status.json")));
	await waitForFile("child started handshake", job.started);
	check("start: returns before release/completion", !existsSync(job.release));
	let status = await readJson(path.join(job.runDir, "status.json"));
	check("start: status reaches running before release", status.state === "running", JSON.stringify(status));
	if (process.platform === "win32") {
		check("start: process startId capture deferred on win32", status.startId === undefined, JSON.stringify(status));
	} else {
		check(
			"start: status records a non-empty process startId",
			typeof status.startId === "string" && status.startId.length > 0,
			JSON.stringify(status),
		);
	}
	await fs.writeFile(job.release, "go");
	status = await waitFor("completed status", async () => {
		const s = await readJson(path.join(job.runDir, "status.json"));
		return s.state === "completed" ? s : false;
	});
	check("complete: status is completed", status.state === "completed", JSON.stringify(status));
	check("complete: exit code is zero", status.exitCode === 0, JSON.stringify(status));
	const stdout = await fs.readFile(path.join(job.runDir, "stdout.log"), "utf8");
	const stderr = await fs.readFile(path.join(job.runDir, "stderr.log"), "utf8");
	const combined = await fs.readFile(path.join(job.runDir, "combined.log"), "utf8");
	check("logs: stdout captured", stdout.includes("hello-stdout"), stdout);
	check("logs: stderr captured", stderr.includes("hello-stderr"), stderr);
	check(
		"logs: combined captured both streams",
		combined.includes("hello-stdout") && combined.includes("hello-stderr"),
		combined,
	);
	const leftoverTemps = (await fs.readdir(job.runDir)).filter((name) => name.includes(".tmp"));
	check("atomic: no temp JSON files left behind", leftoverTemps.length === 0, leftoverTemps.join(","));
}

async function failureIsRecorded(url, check) {
	const { commands } = await loadExtension(url);
	const cwd = await createBgTestDir("pi-bg-fail-");
	const job = await startControlledJob(commands, cwd, { exitCode: 7, check });
	await waitForFile("failing child started", job.started);
	await fs.writeFile(job.release, "fail");
	const status = await waitFor("failed status", async () => {
		const s = await readJson(path.join(job.runDir, "status.json"));
		return s.state === "failed" ? s : false;
	});
	check("failure: status is failed", status.state === "failed", JSON.stringify(status));
	check("failure: exit code recorded", status.exitCode === 7, JSON.stringify(status));
}

async function fastExitDoesNotRegressToRunning(url, check) {
	const { commands } = await loadExtension(url);
	const cwd = await createBgTestDir("pi-bg-fast-exit-");
	const ctx = makeCtx({ cwd, trusted: true });
	const command = `${shellQuote(process.execPath)} -e ${shellQuote("process.exit(0)")}`;
	await commands.get("bg").handler(`start ${command}`, ctx);
	const jobId = parseJobId(ctx._notes.at(-1)?.msg || "");
	const runDir = path.join(cwd, ".pi", "bg", "runs", jobId || "missing");
	const status = await waitFor("fast-exit terminal status", async () => {
		const s = await readJson(path.join(runDir, "status.json"));
		return ["completed", "failed", "cancelled"].includes(s.state) ? s : false;
	});
	check("fast-exit: terminal state wins over running", status.state === "completed", JSON.stringify(status));
	check("fast-exit: active job is eventually removed", status.state !== "running", JSON.stringify(status));
}

async function commandWhitespaceIsPreserved(url, check) {
	const { commands } = await loadExtension(url);
	const cwd = await createBgTestDir("pi-bg-command-");
	const script = path.join(cwd, "argv.cjs");
	const out = path.join(cwd, "argv.txt");
	await fs.writeFile(script, `require("node:fs").writeFileSync(process.argv[2], process.argv[3]);\n`);
	const ctx = makeCtx({ cwd, trusted: true });
	const expected = "alpha  beta";
	const command = `${shellQuote(process.execPath)} ${shellQuote(script)} ${shellQuote(out)} ${shellQuote(expected)}`;
	await commands.get("bg").handler(`start ${command}`, ctx);
	const jobId = parseJobId(ctx._notes.at(-1)?.msg || "");
	const runDir = path.join(cwd, ".pi", "bg", "runs", jobId || "missing");
	await waitFor("argv job completed", async () => {
		const s = await readJson(path.join(runDir, "status.json"));
		return s.state === "completed" ? s : false;
	});
	const actual = await fs.readFile(out, "utf8");
	check("command: quoted whitespace is preserved", actual === expected, JSON.stringify({ expected, actual }));
}

async function startSurfacesFilesystemErrors(url, check) {
	const { commands } = await loadExtension(url);
	const cwd = await createBgTestDir("pi-bg-fserror-");
	// Hace que .pi sea un archivo regular para que ensurePlainDirectory de createRunDir lance a mitad de start.
	await fs.writeFile(path.join(cwd, ".pi"), "not a dir");
	const ctx = makeCtx({ cwd, trusted: true });
	let threw = false;
	try {
		await commands.get("bg").handler("start echo hi", ctx);
	} catch {
		threw = true;
	}
	const note = ctx._notes.at(-1) || {};
	check("fs-error: handler does not throw on filesystem error", !threw);
	check("fs-error: failure surfaced as a clean message", /falló/i.test(note.msg || ""), JSON.stringify(note));
	check("fs-error: response uses the 'error' type", note.type === "error", JSON.stringify(note));
}

async function modeGateRejectsStart(url, check) {
	const { commands } = await loadExtension(url);
	const cwd = await createBgTestDir("pi-bg-mode-");
	const ctx = makeCtx({ cwd, trusted: true, mode: "json", hasUI: true });
	await commands.get("bg").handler("start echo nope", ctx);
	check(
		"mode: /bg start rejected outside TUI/RPC",
		/No se puede ejecutar \/bg start fuera/.test(ctx._notes.at(-1)?.msg || ""),
		ctx._notes.at(-1)?.msg,
	);
	check("mode: rejected start creates no artifacts", !existsSync(path.join(cwd, ".pi")));
}

async function descriptionListsPreviewSubcommand(url, check) {
	const { commands } = await loadExtension(url);
	const desc = commands.get("bg")?.description || "";
	check("description: lists the preview subcommand", /\bpreview\b/.test(desc), desc);
}

async function main() {
	await runBgScenarios({
		name: "pi-bg-jobs-start",
		scenarios: [
			realStartCompletesAndLogs,
			failureIsRecorded,
			fastExitDoesNotRegressToRunning,
			commandWhitespaceIsPreserved,
			startSurfacesFilesystemErrors,
			modeGateRejectsStart,
			descriptionListsPreviewSubcommand,
		],
	});
}

main().catch((err) => {
	console.error(err?.stack || err);
	process.exit(1);
});
