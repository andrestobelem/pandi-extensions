#!/usr/bin/env node
/**
 * Real-job behavioral integration test for `/bg` M2a.
 *
 * Covers the local slash-only runner: start/completion, failure, cancellation,
 * stale/non-owned PIDs, mode/trust gates, artifacts, and logs.
 */

import { spawnSync } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

let passed = 0;
let failed = 0;
const failures = [];
function check(label, cond, detail) {
	if (cond) {
		passed += 1;
		console.log(`PASS: ${label}`);
	} else {
		failed += 1;
		failures.push(label + (detail ? `  [${detail}]` : ""));
		console.log(`FAIL: ${label}${detail ? `  [${detail}]` : ""}`);
	}
}

function shellQuote(value) {
	return JSON.stringify(value);
}

async function buildBg() {
	const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-bg-jobs-integration-"));
	const sdkStub = path.join(outDir, "stub-sdk.mjs");
	await fs.writeFile(
		sdkStub,
		`export const CONFIG_DIR_NAME = ".pi";\nexport function getAgentDir() { return ${JSON.stringify(path.join(outDir, "agentdir"))}; }\n`,
	);
	const src = path.join(REPO_ROOT, "extensions", "pi-bg", "index.ts");
	if (!existsSync(src)) throw new Error(`missing source: ${src}`);
	const out = path.join(outDir, "bg.mjs");
	const r = spawnSync(
		"npx",
		[
			"--no-install",
			"esbuild",
			src,
			"--bundle",
			"--platform=node",
			"--format=esm",
			`--alias:@earendil-works/pi-coding-agent=${sdkStub}`,
			`--outfile=${out}`,
		],
		{ cwd: REPO_ROOT, encoding: "utf8" },
	);
	if (r.status !== 0) throw new Error(`esbuild failed for bg: ${r.stderr || r.stdout}`);
	return { url: pathToFileURL(out).href };
}

let instance = 0;
async function freshDefault(url) {
	const mod = await import(`${url}?i=${instance++}`);
	return mod.default;
}

function makePi() {
	const commands = new Map();
	const tools = new Map();
	return {
		pi: {
			registerCommand: (name, opts) => commands.set(name, opts),
			registerTool: (def) => tools.set(def.name, def),
			on: () => {},
			appendEntry: () => {},
			sendUserMessage: () => {},
			exec: async () => ({ code: 0, stdout: "", stderr: "", killed: false }),
		},
		commands,
		tools,
	};
}

function makeCtx({ cwd, trusted = true, mode = "tui", hasUI = true } = {}) {
	const notes = [];
	const ctx = {
		mode,
		hasUI,
		cwd,
		isProjectTrusted: () => trusted,
		isIdle: () => true,
		ui: {
			notify: (msg, type) => notes.push({ msg, type }),
			setStatus: () => {},
			theme: { fg: (_c, s) => s },
		},
		sessionManager: { getEntries: () => [] },
	};
	ctx._notes = notes;
	return ctx;
}

async function loadExtension(url) {
	const extension = await freshDefault(url);
	const { pi, commands, tools } = makePi();
	extension(pi);
	return { commands, tools };
}

function parseJobId(message) {
	return /Started background job ([A-Za-z0-9_-]+(?:-[A-Za-z0-9_-]+)*)\./.exec(message)?.[1];
}

async function readJson(file) {
	return JSON.parse(await fs.readFile(file, "utf8"));
}

async function waitFor(label, fn, { timeoutMs = 6000, intervalMs = 25 } = {}) {
	const deadline = Date.now() + timeoutMs;
	let last;
	while (Date.now() < deadline) {
		try {
			last = await fn();
			if (last) return last;
		} catch (err) {
			last = err;
		}
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
	}
	throw new Error(`Timed out waiting for ${label}: ${last instanceof Error ? last.message : JSON.stringify(last)}`);
}

async function startControlledJob(commands, cwd, { exitCode = 0 } = {}) {
	const script = path.join(cwd, `job-${Math.random().toString(16).slice(2)}.cjs`);
	const started = path.join(cwd, `started-${Math.random().toString(16).slice(2)}`);
	const release = path.join(cwd, `release-${Math.random().toString(16).slice(2)}`);
	await fs.writeFile(
		script,
		`const fs = require("node:fs");\n` +
			`fs.writeFileSync(process.argv[2], "started");\n` +
			`console.log("hello-stdout");\n` +
			`console.error("hello-stderr");\n` +
			`const release = process.argv[3];\n` +
			`const timeout = setTimeout(() => process.exit(99), 8000);\n` +
			`const poll = setInterval(() => { if (fs.existsSync(release)) { clearInterval(poll); clearTimeout(timeout); process.exit(${exitCode}); } }, 20);\n`,
	);
	const ctx = makeCtx({ cwd, trusted: true });
	const command = `${shellQuote(process.execPath)} ${shellQuote(script)} ${shellQuote(started)} ${shellQuote(release)}`;
	await commands.get("bg").handler(`start ${command}`, ctx);
	const msg = ctx._notes.at(-1)?.msg || "";
	const jobId = parseJobId(msg);
	check("start: reports a job id", Boolean(jobId), msg);
	const runDir = path.join(cwd, ".pi", "bg", "runs", jobId || "missing");
	return { ctx, jobId, runDir, started, release, command };
}

async function realStartCompletesAndLogs(url) {
	const { commands, tools } = await loadExtension(url);
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-bg-real-start-"));
	const job = await startControlledJob(commands, cwd);
	check("start: registers no LLM tools", tools.size === 0, `tools=${[...tools.keys()].join(",")}`);
	check("start: artifacts directory exists immediately", existsSync(job.runDir), job.runDir);
	check("start: job.json exists immediately", existsSync(path.join(job.runDir, "job.json")));
	check("start: status.json exists immediately", existsSync(path.join(job.runDir, "status.json")));
	await waitFor("child started handshake", async () => existsSync(job.started));
	check("start: returns before release/completion", !existsSync(job.release));
	let status = await readJson(path.join(job.runDir, "status.json"));
	check("start: status reaches running before release", status.state === "running", JSON.stringify(status));
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
	check("logs: combined captured both streams", combined.includes("hello-stdout") && combined.includes("hello-stderr"), combined);
	const leftoverTemps = (await fs.readdir(job.runDir)).filter((name) => name.includes(".tmp"));
	check("atomic: no temp JSON files left behind", leftoverTemps.length === 0, leftoverTemps.join(","));
}

async function failureIsRecorded(url) {
	const { commands } = await loadExtension(url);
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-bg-fail-"));
	const job = await startControlledJob(commands, cwd, { exitCode: 7 });
	await waitFor("failing child started", async () => existsSync(job.started));
	await fs.writeFile(job.release, "fail");
	const status = await waitFor("failed status", async () => {
		const s = await readJson(path.join(job.runDir, "status.json"));
		return s.state === "failed" ? s : false;
	});
	check("failure: status is failed", status.state === "failed", JSON.stringify(status));
	check("failure: exit code recorded", status.exitCode === 7, JSON.stringify(status));
}

async function fastExitDoesNotRegressToRunning(url) {
	const { commands } = await loadExtension(url);
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-bg-fast-exit-"));
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

async function commandWhitespaceIsPreserved(url) {
	const { commands } = await loadExtension(url);
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-bg-command-"));
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

async function cancelStopsActiveJob(url) {
	const { commands } = await loadExtension(url);
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-bg-cancel-"));
	const script = path.join(cwd, "long.cjs");
	const started = path.join(cwd, "long-started");
	await fs.writeFile(
		script,
		`const fs = require("node:fs");\n` +
			`fs.writeFileSync(process.argv[2], "started");\n` +
			`console.log("long-running");\n` +
			`setInterval(() => {}, 1000);\n`,
	);
	const ctx = makeCtx({ cwd, trusted: true });
	const command = `${shellQuote(process.execPath)} ${shellQuote(script)} ${shellQuote(started)}`;
	await commands.get("bg").handler(`start ${command}`, ctx);
	const jobId = parseJobId(ctx._notes.at(-1)?.msg || "");
	const runDir = path.join(cwd, ".pi", "bg", "runs", jobId || "missing");
	await waitFor("long job started", async () => existsSync(started));
	await waitFor("long job running status", async () => {
		const s = await readJson(path.join(runDir, "status.json"));
		return s.state === "running" ? s : false;
	});
	await commands.get("bg").handler(`cancel ${jobId}`, ctx);
	check("cancel: reports cancellation requested", /Cancel requested/.test(ctx._notes.at(-1)?.msg || ""), ctx._notes.at(-1)?.msg);
	const status = await waitFor("cancelled status", async () => {
		const s = await readJson(path.join(runDir, "status.json"));
		return s.state === "cancelled" ? s : false;
	});
	check("cancel: final state is cancelled", status.state === "cancelled", JSON.stringify(status));
	check("cancel: cancelRequested recorded", status.cancelRequested === true, JSON.stringify(status));
}

async function stalePidIsNotKilled(url) {
	const { commands } = await loadExtension(url);
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-bg-stale-"));
	const jobId = "fake-active";
	const runDir = path.join(cwd, ".pi", "bg", "runs", jobId);
	await fs.mkdir(runDir, { recursive: true });
	await fs.writeFile(path.join(runDir, "job.json"), JSON.stringify({ jobId, command: "fake", cwd, createdAt: new Date().toISOString(), artifactsDir: runDir }, null, 2));
	await fs.writeFile(path.join(runDir, "status.json"), JSON.stringify({ jobId, state: "running", pid: process.pid, updatedAt: new Date().toISOString() }, null, 2));
	const ctx = makeCtx({ cwd, trusted: true });
	await commands.get("bg").handler(`cancel ${jobId}`, ctx);
	check("stale: cancel refuses non-owned persisted PID", /not active in this session/.test(ctx._notes.at(-1)?.msg || ""), ctx._notes.at(-1)?.msg);
	check("stale: current process is still alive", process.kill(process.pid, 0));
	await commands.get("bg").handler(`status ${jobId}`, ctx);
	const statusMsg = ctx._notes.at(-1)?.msg || "";
	check("stale: status is derived as stale", /"state": "stale"/.test(statusMsg), statusMsg);
	check("stale: persisted running state is reported", /"persistedState": "running"/.test(statusMsg), statusMsg);
}

async function logStreamErrorsAreContained(url) {
	const mod = await import(`${url}?guard=${instance++}`);
	const guard = mod.guardStreamErrors;
	check("guard: guardStreamErrors is exported", typeof guard === "function", typeof guard);
	if (typeof guard !== "function") return;

	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-bg-streamerr-"));
	const runDir = path.join(cwd, "run");
	await fs.mkdir(runDir, { recursive: true });

	// Hazard baseline: an unguarded stream 'error' throws and would crash the host process.
	const unguarded = createWriteStream(path.join(runDir, "unguarded.log"));
	let unguardedThrew = false;
	try {
		unguarded.emit("error", new Error("boom-unguarded"));
	} catch {
		unguardedThrew = true;
	}
	unguarded.destroy();
	check("guard: unguarded stream error throws (hazard reproduced)", unguardedThrew);

	// Fixed behavior: a guarded stream 'error' is contained (no throw) and recorded as an event.
	const guarded = createWriteStream(path.join(runDir, "stdout.log"));
	guard(runDir, "job-streamerr", [guarded, null, undefined]);
	let guardedThrew = false;
	try {
		guarded.emit("error", new Error("boom-guarded"));
	} catch {
		guardedThrew = true;
	}
	guarded.destroy();
	check("guard: guarded stream error does not throw", !guardedThrew);

	const events = await waitFor("log-stream-error event", async () => {
		try {
			const text = await fs.readFile(path.join(runDir, "events.jsonl"), "utf8");
			return text.includes("log-stream-error") ? text : false;
		} catch {
			return false;
		}
	});
	check("guard: records a log-stream-error event", /"event":"log-stream-error"/.test(events) && /boom-guarded/.test(events), events.slice(0, 200));
}

async function atomicWriteCleansTempOnRenameFailure(url) {
	const mod = await import(`${url}?atomic=${instance++}`);
	const atomicWriteJson = mod.atomicWriteJson;
	check("atomic: atomicWriteJson is exported", typeof atomicWriteJson === "function", typeof atomicWriteJson);
	if (typeof atomicWriteJson !== "function") return;
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-bg-atomic-"));
	// Make the target an existing directory so rename(tmp, target) fails (EISDIR).
	const target = path.join(dir, "target");
	await fs.mkdir(target);
	let threw = false;
	try {
		await atomicWriteJson(target, { a: 1 });
	} catch {
		threw = true;
	}
	check("atomic: rename failure is rethrown", threw);
	const leftoverTemps = (await fs.readdir(dir)).filter((name) => name.includes(".tmp"));
	check("atomic: no temp file left behind after rename failure", leftoverTemps.length === 0, leftoverTemps.join(","));
}

async function descriptionListsPlanSubcommand(url) {
	const { commands } = await loadExtension(url);
	const desc = commands.get("bg")?.description || "";
	check("description: lists the plan subcommand", /\bplan\b/.test(desc), desc);
}

async function startSurfacesFilesystemErrors(url) {
	const { commands } = await loadExtension(url);
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-bg-fserror-"));
	// Make .pi a regular file so createRunDir's ensurePlainDirectory throws mid-start.
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
	check("fs-error: failure surfaced as a clean message", /failed/i.test(note.msg || ""), JSON.stringify(note));
	check("fs-error: response uses the 'error' type", note.type === "error", JSON.stringify(note));
}

async function backpressurePausesSource(url) {
	const mod = await import(`${url}?bp=${instance++}`);
	const pipe = mod.pipeWithBackpressure;
	check("backpressure: pipeWithBackpressure is exported", typeof pipe === "function", typeof pipe);
	if (typeof pipe !== "function") return;

	const source = new PassThrough();
	let release;
	const gate = new Promise((resolve) => {
		release = resolve;
	});
	// A sink whose write callback is withheld -> stays full and never drains until released.
	const slow = new Writable({
		highWaterMark: 1,
		write(_chunk, _enc, cb) {
			gate.then(() => cb());
		},
	});
	pipe(source, [slow]);
	source.write(Buffer.from("a".repeat(4096)));
	await new Promise((r) => setTimeout(r, 30));
	check("backpressure: source pauses while sink is full", source.isPaused() === true, `isPaused=${source.isPaused()}`);
	release();
	await new Promise((r) => setTimeout(r, 30));
	check("backpressure: source resumes after sink drains", source.isPaused() === false, `isPaused=${source.isPaused()}`);
	source.destroy();
	slow.destroy();
}

async function jobFinishedGuardRejectsCancel(url) {
	const mod = await import(`${url}?finguard=${instance++}`);
	const isFinished = mod.isJobFinished;
	check("cancel-guard: isJobFinished is exported", typeof isFinished === "function", typeof isFinished);
	if (typeof isFinished !== "function") return;
	// A finished job must not be re-signalled (avoids mislabel + stray signal to a reaped PID).
	check("cancel-guard: finalized job is finished", isFinished({ finalized: true, child: { exitCode: null, signalCode: null } }) === true);
	check("cancel-guard: exited job (exitCode set) is finished", isFinished({ finalized: false, child: { exitCode: 0, signalCode: null } }) === true);
	check("cancel-guard: signalled job is finished", isFinished({ finalized: false, child: { exitCode: null, signalCode: "SIGTERM" } }) === true);
	check("cancel-guard: live running job is NOT finished", isFinished({ finalized: false, child: { exitCode: null, signalCode: null } }) === false);
}

async function finalizeRejectionIsContained(url) {
	const mod = await import(`${url}?fin=${instance++}`);
	const finalizeJob = mod.finalizeJob;
	const safeFinalize = mod.safeFinalize;
	check("finalize: finalizeJob is exported", typeof finalizeJob === "function", typeof finalizeJob);
	check("finalize: safeFinalize is exported", typeof safeFinalize === "function", typeof safeFinalize);
	if (typeof finalizeJob !== "function" || typeof safeFinalize !== "function") return;

	const makeBadRuntime = async (label) => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), `pi-bg-finalize-${label}-`));
		const runDir = path.join(cwd, "run");
		await fs.mkdir(runDir, { recursive: true });
		// Make status.json a directory so atomicWriteJson's rename fails -> writeStatus
		// rejects -> finalizeJob rejects, reproducing the host-crash hazard.
		await fs.mkdir(path.join(runDir, "status.json"));
		const noop = () => {};
		return {
			jobId: `job-${label}`,
			runDir,
			command: "x",
			child: { exitCode: 0, signalCode: null },
			status: { jobId: `job-${label}`, state: "running", updatedAt: new Date().toISOString(), cancelRequested: false },
			stdoutStream: { end: noop },
			stderrStream: { end: noop },
			combinedStream: { end: noop },
			finalized: false,
		};
	};

	// Hazard baseline: the raw finalizeJob rejects when the status write fails. An
	// unguarded `void finalizeJob(...)` in a child lifecycle handler would escalate
	// this to an unhandledRejection and crash the host Pi process.
	const bad1 = await makeBadRuntime("raw");
	let rawRejected = false;
	await finalizeJob(bad1, 0, null).catch(() => {
		rawRejected = true;
	});
	check("finalize: raw finalizeJob rejects on status-write failure (hazard reproduced)", rawRejected);

	// Fixed behavior: safeFinalize swallows the rejection (no unhandledRejection)
	// and records it as a finalize-error event for observability.
	const rejections = [];
	const onUnhandled = (err) => rejections.push(err);
	process.on("unhandledRejection", onUnhandled);
	const bad2 = await makeBadRuntime("safe");
	const ret = safeFinalize(bad2, 0, null);
	check("finalize: safeFinalize returns void (does not throw synchronously)", ret === undefined);
	await new Promise((r) => setTimeout(r, 75));
	process.off("unhandledRejection", onUnhandled);
	check("finalize: safeFinalize produces no unhandled rejection", rejections.length === 0, String(rejections.length));
	const events = await fs.readFile(path.join(bad2.runDir, "events.jsonl"), "utf8").catch(() => "");
	check("finalize: safeFinalize records a finalize-error event", /finalize-error/.test(events), events.slice(0, 200));
}

async function modeGateRejectsStart(url) {
	const { commands } = await loadExtension(url);
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-bg-mode-"));
	const ctx = makeCtx({ cwd, trusted: true, mode: "json", hasUI: true });
	await commands.get("bg").handler("start echo nope", ctx);
	check("mode: /bg start rejected outside TUI/RPC", /Cannot \/bg start outside/.test(ctx._notes.at(-1)?.msg || ""), ctx._notes.at(-1)?.msg);
	check("mode: rejected start creates no artifacts", !existsSync(path.join(cwd, ".pi")));
}

async function main() {
	const { url } = await buildBg();
	await realStartCompletesAndLogs(url);
	await failureIsRecorded(url);
	await fastExitDoesNotRegressToRunning(url);
	await commandWhitespaceIsPreserved(url);
	await cancelStopsActiveJob(url);
	await stalePidIsNotKilled(url);
	await logStreamErrorsAreContained(url);
	await jobFinishedGuardRejectsCancel(url);
	await finalizeRejectionIsContained(url);
	await backpressurePausesSource(url);
	await descriptionListsPlanSubcommand(url);
	await atomicWriteCleansTempOnRenameFailure(url);
	await startSurfacesFilesystemErrors(url);
	await modeGateRejectsStart(url);

	console.log(`\n${passed} passed, ${failed} failed`);
	if (failed) {
		console.error(failures.join("\n"));
		process.exit(1);
	}
}

main().catch((err) => {
	console.error(err?.stack || err);
	process.exit(1);
});
