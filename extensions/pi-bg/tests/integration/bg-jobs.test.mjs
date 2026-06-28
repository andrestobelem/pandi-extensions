#!/usr/bin/env node
/**
 * Real-job behavioral integration test for `/bg` M2a.
 *
 * Covers the local slash-only runner: start/completion, failure, cancellation,
 * stale/non-owned PIDs, mode/trust gates, artifacts, and logs.
 */

import { spawn, spawnSync } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { buildExtension, createChecker, loadDefault, loadModule, sdkStub } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

const { check, counts } = createChecker();

function shellQuote(value) {
	return JSON.stringify(value);
}

async function buildBg() {
	const { url } = await buildExtension({
		name: "pi-bg-jobs-integration",
		src: path.join(REPO_ROOT, "extensions", "pi-bg", "index.ts"),
		outName: "bg.mjs",
		stubs: { sdk: (dir) => sdkStub(dir) },
		npx: "--no-install",
	});
	return { url };
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
	const extension = await loadDefault(url);
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
	check(
		"cancel: reports cancellation requested",
		/Cancel requested/.test(ctx._notes.at(-1)?.msg || ""),
		ctx._notes.at(-1)?.msg,
	);
	const status = await waitFor("cancelled status", async () => {
		const s = await readJson(path.join(runDir, "status.json"));
		return s.state === "cancelled" ? s : false;
	});
	check("cancel: final state is cancelled", status.state === "cancelled", JSON.stringify(status));
	check("cancel: cancelRequested recorded", status.cancelRequested === true, JSON.stringify(status));
}

async function cancelEscalatesToSigkill(url) {
	if (process.platform === "win32") {
		check("cancel-sigkill: skipped on win32 (taskkill path not exercised here)", true);
		return;
	}
	const { commands } = await loadExtension(url);
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-bg-sigkill-"));
	const script = path.join(cwd, "ignore-sigterm.cjs");
	const started = path.join(cwd, "sigterm-started");
	// A child that INSTALLS a SIGTERM handler and keeps running -> it survives the
	// initial SIGTERM, so finalization only happens once the grace-timer escalates to
	// SIGKILL. The existing cancel test uses a child without a handler (dies on SIGTERM),
	// so this is the only coverage of the riskiest cancellation path.
	await fs.writeFile(
		script,
		`const fs = require("node:fs");\n` +
			`process.on("SIGTERM", () => { /* ignore: survive until SIGKILL */ });\n` +
			`fs.writeFileSync(process.argv[2], "started");\n` +
			`console.log("ignoring-sigterm");\n` +
			`setInterval(() => {}, 1000);\n`,
	);
	const ctx = makeCtx({ cwd, trusted: true });
	const command = `${shellQuote(process.execPath)} ${shellQuote(script)} ${shellQuote(started)}`;
	await commands.get("bg").handler(`start ${command}`, ctx);
	const jobId = parseJobId(ctx._notes.at(-1)?.msg || "");
	const runDir = path.join(cwd, ".pi", "bg", "runs", jobId || "missing");
	await waitFor("sigterm-ignoring child started", async () => existsSync(started));
	await waitFor("running status", async () => {
		const s = await readJson(path.join(runDir, "status.json"));
		return s.state === "running" ? s : false;
	});

	const tCancel = Date.now();
	await commands.get("bg").handler(`cancel ${jobId}`, ctx);
	const status = await waitFor(
		"cancelled status after SIGKILL escalation",
		async () => {
			const s = await readJson(path.join(runDir, "status.json"));
			return s.state === "cancelled" ? s : false;
		},
		{ timeoutMs: 8000 },
	);
	check("cancel-sigkill: final state is cancelled", status.state === "cancelled", JSON.stringify(status));
	check(
		"cancel-sigkill: died only after the grace period (SIGTERM was ignored)",
		Date.now() - tCancel >= 700,
		`elapsed=${Date.now() - tCancel}`,
	);
	const events = await fs.readFile(path.join(runDir, "events.jsonl"), "utf8").catch(() => "");
	check(
		"cancel-sigkill: records a cancel-sigkill escalation event",
		/"event":"cancel-sigkill"/.test(events),
		events.slice(-300),
	);
}

async function orphanedPidIsLabeledNotKilled(url) {
	const { commands } = await loadExtension(url);
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-bg-orphan-"));
	const jobId = "fake-active";
	const runDir = path.join(cwd, ".pi", "bg", "runs", jobId);
	await fs.mkdir(runDir, { recursive: true });
	await fs.writeFile(
		path.join(runDir, "job.json"),
		JSON.stringify(
			{ jobId, command: "fake", cwd, createdAt: new Date().toISOString(), artifactsDir: runDir },
			null,
			2,
		),
	);
	// pid = this live test process, not owned by the bg session => orphaned (alive elsewhere).
	await fs.writeFile(
		path.join(runDir, "status.json"),
		JSON.stringify({ jobId, state: "running", pid: process.pid, updatedAt: new Date().toISOString() }, null, 2),
	);
	const ctx = makeCtx({ cwd, trusted: true });
	await commands.get("bg").handler(`cancel ${jobId}`, ctx);
	check(
		"orphaned: cancel refuses non-owned persisted PID",
		/refus/i.test(ctx._notes.at(-1)?.msg || ""),
		ctx._notes.at(-1)?.msg,
	);
	check("orphaned: current process is still alive", process.kill(process.pid, 0));
	await commands.get("bg").handler(`status ${jobId}`, ctx);
	const statusMsg = ctx._notes.at(-1)?.msg || "";
	check("orphaned: live persisted PID is derived as orphaned", /"state": "orphaned"/.test(statusMsg), statusMsg);
	check("orphaned: persisted running state is reported", /"persistedState": "running"/.test(statusMsg), statusMsg);
	check(
		"orphaned: status surfaces a verify-before-kill hint",
		/"hint":/.test(statusMsg) && /reused/.test(statusMsg),
		statusMsg,
	);
	await commands.get("bg").handler("list", ctx);
	check(
		"orphaned: list reflects orphaned state",
		/fake-active: orphaned/.test(ctx._notes.at(-1)?.msg || ""),
		ctx._notes.at(-1)?.msg,
	);
}

async function interruptedAndStaleStatesAreDerived(url) {
	const { commands } = await loadExtension(url);
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-bg-interrupted-"));
	const runsRoot = path.join(cwd, ".pi", "bg", "runs");

	// (1) Persisted running, recorded pid is dead (reaped) => interrupted.
	const dead = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
	check(
		"interrupted: probe child exited cleanly",
		dead.status === 0,
		JSON.stringify({ status: dead.status, pid: dead.pid }),
	);
	const deadJob = "dead-job";
	const deadDir = path.join(runsRoot, deadJob);
	await fs.mkdir(deadDir, { recursive: true });
	await fs.writeFile(
		path.join(deadDir, "job.json"),
		JSON.stringify({ jobId: deadJob, command: "gone", cwd, createdAt: new Date().toISOString() }, null, 2),
	);
	await fs.writeFile(
		path.join(deadDir, "status.json"),
		JSON.stringify(
			{ jobId: deadJob, state: "running", pid: dead.pid, updatedAt: new Date().toISOString() },
			null,
			2,
		),
	);

	// (2) Persisted starting with NO recorded pid => stale fallback (cannot probe).
	const noPidJob = "nopid-job";
	const noPidDir = path.join(runsRoot, noPidJob);
	await fs.mkdir(noPidDir, { recursive: true });
	await fs.writeFile(
		path.join(noPidDir, "job.json"),
		JSON.stringify({ jobId: noPidJob, command: "starting", cwd, createdAt: new Date().toISOString() }, null, 2),
	);
	await fs.writeFile(
		path.join(noPidDir, "status.json"),
		JSON.stringify({ jobId: noPidJob, state: "starting", updatedAt: new Date().toISOString() }, null, 2),
	);

	const ctx = makeCtx({ cwd, trusted: true });
	await commands.get("bg").handler(`status ${deadJob}`, ctx);
	const deadMsg = ctx._notes.at(-1)?.msg || "";
	check("interrupted: dead persisted PID is derived as interrupted", /"state": "interrupted"/.test(deadMsg), deadMsg);
	check("interrupted: persisted running state is reported", /"persistedState": "running"/.test(deadMsg), deadMsg);

	await commands.get("bg").handler(`status ${noPidJob}`, ctx);
	const noPidMsg = ctx._notes.at(-1)?.msg || "";
	check("stale: unprobeable (no pid) job falls back to stale", /"state": "stale"/.test(noPidMsg), noPidMsg);
	check("stale: persisted starting state is reported", /"persistedState": "starting"/.test(noPidMsg), noPidMsg);

	await commands.get("bg").handler("list", ctx);
	const listMsg = ctx._notes.at(-1)?.msg || "";
	check("list: reflects interrupted state", /dead-job: interrupted/.test(listMsg), listMsg);
	check("list: reflects stale fallback state", /nopid-job: stale/.test(listMsg), listMsg);
}

async function processStartIdCapturesIdentity(url) {
	const mod = await loadModule(url);
	const readStartId = mod.readProcessStartId;
	check("startid: readProcessStartId is exported", typeof readStartId === "function", typeof readStartId);
	if (typeof readStartId !== "function") return;
	check(
		"startid: invalid pids yield undefined",
		readStartId(undefined) === undefined &&
			readStartId(0) === undefined &&
			readStartId(-1) === undefined &&
			readStartId(1.5) === undefined,
	);
	const dead = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
	check(
		"startid: probe child exited cleanly",
		dead.status === 0,
		JSON.stringify({ status: dead.status, pid: dead.pid }),
	);
	if (process.platform === "win32") {
		// Windows identity capture is deferred (graceful degradation to best-effort liveness).
		check(
			"startid: win32 identity capture is deferred (undefined)",
			readStartId(process.pid) === undefined,
			String(readStartId(process.pid)),
		);
	} else {
		const self = readStartId(process.pid);
		check(
			"startid: a live process yields a non-empty identity",
			typeof self === "string" && self.length > 0,
			String(self),
		);
		check(
			"startid: a reaped pid yields undefined",
			readStartId(dead.pid) === undefined,
			String(readStartId(dead.pid)),
		);
	}
}

async function livenessProbeClassifiesPids(url) {
	const mod = await loadModule(url);
	const probe = mod.probeProcessAlive;
	check("liveness: probeProcessAlive is exported", typeof probe === "function", typeof probe);
	if (typeof probe !== "function") return;
	// A signal-0 probe sends no signal; it only asks whether some process holds the pid.
	check("liveness: current process is alive", probe(process.pid) === "alive", String(probe(process.pid)));
	check("liveness: undefined pid is unknown", probe(undefined) === "unknown", String(probe(undefined)));
	check(
		"liveness: zero/negative/non-integer pid is unknown",
		probe(0) === "unknown" && probe(-1) === "unknown" && probe(1.5) === "unknown",
		JSON.stringify([probe(0), probe(-1), probe(1.5)]),
	);
	// Spawn a short-lived child and let spawnSync reap it, then probe its now-dead pid.
	const dead = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
	check(
		"liveness: spawned probe child exited cleanly",
		dead.status === 0,
		JSON.stringify({ status: dead.status, pid: dead.pid }),
	);
	check("liveness: a reaped child pid is dead", probe(dead.pid) === "dead", String(probe(dead.pid)));
}

async function reconcileRewritesDeadRunningJobs(url) {
	const mod = await loadModule(url);
	const reconcile = mod.reconcileInterruptedJobs;
	check("reconcile: reconcileInterruptedJobs is exported", typeof reconcile === "function", typeof reconcile);
	if (typeof reconcile !== "function") return;

	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-bg-reconcile-"));
	const runsRoot = path.join(cwd, ".pi", "bg", "runs");
	const dead = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
	check(
		"reconcile: probe child exited cleanly",
		dead.status === 0,
		JSON.stringify({ status: dead.status, pid: dead.pid }),
	);
	const write = async (jobId, status) => {
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
	const deadDir = await write("dead-run", { state: "running", pid: dead.pid });
	const aliveDir = await write("alive-run", { state: "running", pid: process.pid });
	const noPidDir = await write("nopid-run", { state: "starting" });
	const doneDir = await write("done-run", { state: "completed", exitCode: 0 });

	const ctx = makeCtx({ cwd, trusted: true });
	const n = await reconcile(ctx);
	check("reconcile: reconciles exactly the one dead running job", n === 1, String(n));

	const deadStatus = await readJson(path.join(deadDir, "status.json"));
	check(
		"reconcile: dead running job becomes interrupted",
		deadStatus.state === "interrupted",
		JSON.stringify(deadStatus),
	);
	check(
		"reconcile: interrupted job records a reason",
		deadStatus.reason === "session-start-reconcile",
		JSON.stringify(deadStatus),
	);
	check(
		"reconcile: interrupted job records completedAt",
		typeof deadStatus.completedAt === "string",
		JSON.stringify(deadStatus),
	);

	const aliveStatus = await readJson(path.join(aliveDir, "status.json"));
	check(
		"reconcile: live running job is left as running on disk",
		aliveStatus.state === "running",
		JSON.stringify(aliveStatus),
	);
	const noPidStatus = await readJson(path.join(noPidDir, "status.json"));
	check(
		"reconcile: unprobeable (no pid) job is left untouched",
		noPidStatus.state === "starting",
		JSON.stringify(noPidStatus),
	);
	const doneStatus = await readJson(path.join(doneDir, "status.json"));
	check("reconcile: terminal job is left untouched", doneStatus.state === "completed", JSON.stringify(doneStatus));

	const n2 = await reconcile(ctx);
	check("reconcile: idempotent second pass changes nothing", n2 === 0, String(n2));
	const temps = (await fs.readdir(deadDir)).filter((f) => f.includes(".tmp"));
	check("reconcile: leaves no temp files behind", temps.length === 0, temps.join(","));

	const untrustedCwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-bg-reconcile-untrusted-"));
	const uDir = path.join(untrustedCwd, ".pi", "bg", "runs", "dead-untrusted");
	await fs.mkdir(uDir, { recursive: true });
	await fs.writeFile(
		path.join(uDir, "status.json"),
		JSON.stringify(
			{
				jobId: "dead-untrusted",
				state: "running",
				pid: dead.pid,
				updatedAt: new Date().toISOString(),
			},
			null,
			2,
		),
	);
	const nUntrusted = await reconcile(makeCtx({ cwd: untrustedCwd, trusted: false }));
	check("reconcile: untrusted project is not reconciled", nUntrusted === 0, String(nUntrusted));
	const untrustedStatus = await readJson(path.join(uDir, "status.json"));
	check(
		"reconcile: untrusted status left as running",
		untrustedStatus.state === "running",
		JSON.stringify(untrustedStatus),
	);
}

async function verifyProcessIdentityDetectsReuse(url) {
	const mod = await loadModule(url);
	const verify = mod.verifyProcessIdentity;
	const readStartId = mod.readProcessStartId;
	check("verify: verifyProcessIdentity is exported", typeof verify === "function", typeof verify);
	if (typeof verify !== "function") return;
	check(
		"verify: missing recorded identity is unknown",
		verify(process.pid, undefined) === "unknown",
		String(verify(process.pid, undefined)),
	);
	const dead = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
	check(
		"verify: a dead pid cannot be confirmed (unknown)",
		verify(dead.pid, "anything") === "unknown",
		String(verify(dead.pid, "anything")),
	);
	if (process.platform === "win32") {
		check(
			"verify: win32 cannot verify identity (unknown)",
			verify(process.pid, "stale:bogus") === "unknown",
			String(verify(process.pid, "stale:bogus")),
		);
	} else {
		const id = readStartId(process.pid);
		check("verify: matching identity is same", verify(process.pid, id) === "same", String(verify(process.pid, id)));
		check(
			"verify: stale identity is different (pid reused)",
			verify(process.pid, "stale:bogus") === "different",
			String(verify(process.pid, "stale:bogus")),
		);
	}
}

async function identityDefeatsPidReuse(url) {
	const mod = await loadModule(url);
	const readStartId = mod.readProcessStartId;
	const reconcile = mod.reconcileInterruptedJobs;
	const { commands } = await loadExtension(url);
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-bg-identity-"));
	const runsRoot = path.join(cwd, ".pi", "bg", "runs");
	const liveId = readStartId(process.pid);
	const write = async (jobId, status) => {
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
	// pid alive (this process) but recorded startId is stale => the pid was reused.
	const reusedDir = await write("reused", {
		state: "running",
		pid: process.pid,
		startId: "stale:bogus-identity",
	});
	// pid alive AND recorded startId matches => genuinely our orphaned process.
	const verifiedDir = await write("verified", {
		state: "running",
		pid: process.pid,
		startId: liveId,
	});
	const ctx = makeCtx({ cwd, trusted: true });
	const win32 = process.platform === "win32";

	await commands.get("bg").handler("status reused", ctx);
	const reusedMsg = ctx._notes.at(-1)?.msg || "";
	await commands.get("bg").handler("status verified", ctx);
	const verifiedMsg = ctx._notes.at(-1)?.msg || "";
	if (win32) {
		check("identity: win32 status keeps best-effort orphaned", /"state": "orphaned"/.test(reusedMsg), reusedMsg);
	} else {
		check(
			"identity: status downgrades a reused pid to interrupted",
			/"state": "interrupted"/.test(reusedMsg),
			reusedMsg,
		);
		check(
			"identity: status keeps a verified orphan as orphaned",
			/"state": "orphaned"/.test(verifiedMsg) && /"identity": "verified"/.test(verifiedMsg),
			verifiedMsg,
		);
	}

	const n = await reconcile(ctx);
	const reusedState = JSON.parse(await fs.readFile(path.join(reusedDir, "status.json"), "utf8")).state;
	const verifiedState = JSON.parse(await fs.readFile(path.join(verifiedDir, "status.json"), "utf8")).state;
	if (win32) {
		check("identity: win32 reconcile leaves reused pid running", reusedState === "running", reusedState);
	} else {
		check("identity: reconcile rewrites a reused pid to interrupted", reusedState === "interrupted", reusedState);
		check("identity: reconcile leaves a verified orphan running", verifiedState === "running", verifiedState);
		check("identity: reconcile reports rewriting the reused job", n >= 1, String(n));
	}
}

async function cancelSignalsVerifiedOrphan(url) {
	if (process.platform === "win32") {
		check("cancel-orphan: verified-orphan signaling exercised on POSIX only (skipped on win32)", true);
		return;
	}
	const mod = await loadModule(url);
	const readStartId = mod.readProcessStartId;
	const { commands } = await loadExtension(url);
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-bg-cancel-orphan-"));
	const jobId = "verified-orphan";
	const runDir = path.join(cwd, ".pi", "bg", "runs", jobId);
	await fs.mkdir(runDir, { recursive: true });
	// A real detached process group we own at the OS level but NOT in this bg session.
	const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
		detached: true,
		stdio: "ignore",
	});
	child.unref();
	await new Promise((r) => setTimeout(r, 200));
	const startId = readStartId(child.pid);
	check(
		"cancel-orphan: captured a live start identity for the child",
		typeof startId === "string" && startId.length > 0,
		String(startId),
	);
	try {
		await fs.writeFile(
			path.join(runDir, "job.json"),
			JSON.stringify(
				{
					jobId,
					command: "sleeper",
					cwd,
					createdAt: new Date().toISOString(),
					artifactsDir: runDir,
				},
				null,
				2,
			),
		);
		await fs.writeFile(
			path.join(runDir, "status.json"),
			JSON.stringify(
				{ jobId, state: "running", pid: child.pid, startId, updatedAt: new Date().toISOString() },
				null,
				2,
			),
		);
		const ctx = makeCtx({ cwd, trusted: true });
		await commands.get("bg").handler(`cancel ${jobId}`, ctx);
		const msg = ctx._notes.at(-1)?.msg || "";
		check(
			"cancel-orphan: reports signaling the verified orphan",
			/SIGTERM/.test(msg) && /verified orphan/i.test(msg),
			msg,
		);
		const dead = await waitFor(
			"verified orphan process exits after SIGTERM",
			async () => {
				try {
					process.kill(child.pid, 0);
					return false;
				} catch {
					return true;
				}
			},
			{ timeoutMs: 8000 },
		);
		check("cancel-orphan: the verified orphan process was actually killed", dead === true);
		const status = await readJson(path.join(runDir, "status.json"));
		check(
			"cancel-orphan: status is rewritten to cancelled",
			status.state === "cancelled" && status.reason === "cancel-verified-orphan",
			JSON.stringify(status),
		);
		const events = await fs.readFile(path.join(runDir, "events.jsonl"), "utf8").catch(() => "");
		check(
			"cancel-orphan: records a cancel-verified-orphan event",
			/cancel-verified-orphan/.test(events),
			events.slice(-300),
		);
	} finally {
		try {
			process.kill(-child.pid, "SIGKILL");
		} catch {
			/* best-effort: the process group may already be gone */
		}
		try {
			process.kill(child.pid, "SIGKILL");
		} catch {
			/* best-effort: the child may already be gone */
		}
	}
}

async function cancelRefusesReusedPid(url) {
	const { commands } = await loadExtension(url);
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-bg-cancel-reuse-"));
	const jobId = "reused-cancel";
	const runDir = path.join(cwd, ".pi", "bg", "runs", jobId);
	await fs.mkdir(runDir, { recursive: true });
	await fs.writeFile(
		path.join(runDir, "job.json"),
		JSON.stringify(
			{ jobId, command: "x", cwd, createdAt: new Date().toISOString(), artifactsDir: runDir },
			null,
			2,
		),
	);
	// Live pid (this process) but a stale recorded identity => pid reuse: must NOT be signaled.
	await fs.writeFile(
		path.join(runDir, "status.json"),
		JSON.stringify(
			{
				jobId,
				state: "running",
				pid: process.pid,
				startId: "stale:bogus-identity",
				updatedAt: new Date().toISOString(),
			},
			null,
			2,
		),
	);
	const ctx = makeCtx({ cwd, trusted: true });
	await commands.get("bg").handler(`cancel ${jobId}`, ctx);
	const msg = ctx._notes.at(-1)?.msg || "";
	check("cancel-reuse: current process still alive (never signaled)", process.kill(process.pid, 0));
	const status = await readJson(path.join(runDir, "status.json"));
	check("cancel-reuse: status is left running (not cancelled)", status.state === "running", JSON.stringify(status));
	if (process.platform === "win32") {
		check("cancel-reuse: win32 refuses (identity unverifiable)", /refus/i.test(msg), msg);
	} else {
		check("cancel-reuse: refuses a reused pid and explains why", /refus/i.test(msg) && /reus/i.test(msg), msg);
	}
}

// R2: /bg delete gate re-derives LIVE state (never trusts status.json.state) and refines
// an orphaned pid by identity, so active/verified-alive/unknown jobs are never deletable
// while a reused-pid (different identity => interrupted) job is.
async function deleteGateReDerivesLiveState(url) {
	const mod = await loadModule(url);
	const readStartId = mod.readProcessStartId;
	const { commands } = await loadExtension(url);
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-bg-delete-gate-"));
	const runsRoot = path.join(cwd, ".pi", "bg", "runs");
	const ctx = makeCtx({ cwd, trusted: true });
	const win32 = process.platform === "win32";
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
	const del = async (jobId) => {
		await commands.get("bg").handler(`delete ${jobId}`, ctx);
		return ctx._notes.at(-1)?.msg || "";
	};

	const aliveDir = await seed("alive-orphan", {
		state: "running",
		pid: process.pid,
		startId: readStartId(process.pid),
	});
	const aliveMsg = await del("alive-orphan");
	check("delete-gate: refuses a verified-alive orphan", existsSync(aliveDir), aliveMsg);
	if (!win32) check("delete-gate: explains the alive refusal", /cannot be deleted|alive/i.test(aliveMsg), aliveMsg);

	const unkDir = await seed("unknown-orphan", { state: "running", pid: process.pid });
	const unkMsg = await del("unknown-orphan");
	check("delete-gate: refuses an unknown-identity orphan", existsSync(unkDir), unkMsg);

	const reusedDir = await seed("reused-pid", {
		state: "running",
		pid: process.pid,
		startId: "stale:bogus-identity",
	});
	const reusedMsg = await del("reused-pid");
	if (win32) {
		check("delete-gate: win32 keeps a reused-pid orphan (unverifiable)", existsSync(reusedDir), reusedMsg);
	} else {
		check(
			"delete-gate: deletes a reused-pid job (refined to interrupted)",
			!existsSync(reusedDir) && /deleted/i.test(reusedMsg),
			reusedMsg,
		);
	}

	const job = await startControlledJob(commands, cwd);
	await waitFor("active job is owned", async () => {
		await commands.get("bg").handler(`status ${job.jobId}`, job.ctx);
		return /"active": true/.test(job.ctx._notes.at(-1)?.msg || "");
	});
	const activeMsg = await del(job.jobId);
	check("delete-gate: refuses a job active in this session", existsSync(job.runDir), activeMsg);
	check("delete-gate: explains the active refusal", /active/i.test(activeMsg), activeMsg);
	await fs.writeFile(job.release, "go");
	await waitFor(
		"active job finished",
		async () => (await readJson(path.join(job.runDir, "status.json")))?.state === "completed",
	);
}

// R3: removeRunDir re-validates liveness at the edge (immediately before fs.rm) and aborts
// the removal if the injected re-check says the job is no longer deletable.
async function removeRunDirRevalidatesBeforeRm(url) {
	const mod = await loadModule(url);
	const removeRunDir = mod.removeRunDir;
	check("revalidate: removeRunDir is exported", typeof removeRunDir === "function", typeof removeRunDir);
	if (typeof removeRunDir !== "function") return;
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-bg-revalidate-"));
	const dir = path.join(cwd, ".pi", "bg", "runs", "guard-job");
	await fs.mkdir(dir, { recursive: true });
	await fs.writeFile(
		path.join(dir, "status.json"),
		JSON.stringify({ jobId: "guard-job", state: "completed", updatedAt: new Date().toISOString() }, null, 2),
	);
	const ctx = makeCtx({ cwd, trusted: true });
	const aborted = await removeRunDir(ctx, "guard-job", { verb: "delete" }, async () => false);
	check(
		"revalidate: an aborting re-check leaves the dir intact",
		aborted === false && existsSync(dir),
		`aborted=${aborted}`,
	);
	const removed = await removeRunDir(ctx, "guard-job", { verb: "delete" }, async () => true);
	check("revalidate: a passing re-check removes the dir", removed === true && !existsSync(dir), `removed=${removed}`);
}

// R4 unit: the --yes-only parser (a typo stays a safe dry-run) and the symlink-skipping
// lstat-walk size helper.
async function pruneFlagAndSizeHelpers(url) {
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
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-bg-size-"));
	await fs.writeFile(path.join(dir, "a.log"), "12345");
	await fs.writeFile(path.join(dir, "b.log"), "678");
	const external = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "pi-bg-size-ext-")), "big.bin");
	await fs.writeFile(external, "x".repeat(10000));
	await fs.symlink(external, path.join(dir, "link.log"));
	check(
		"prune-size: sums regular files and skips symlinks",
		(await dirSizeBytes(dir)) === 8,
		String(await dirSizeBytes(dir)),
	);
}

// R4 integration: /bg prune defaults to a dry run — lists terminal candidates, skips a
// live job with a reason, prompts for --yes, and removes nothing.
async function prunePreviewListsCandidatesWithoutDeleting(url) {
	const { commands } = await loadExtension(url);
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-bg-prune-preview-"));
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
		/delete done-1/.test(msg) && /delete fail-1/.test(msg),
		msg,
	);
	check("prune-preview: skips the alive job with a reason", /skip\s+run-1/.test(msg), msg);
	check("prune-preview: prompts for --yes", /--yes/.test(msg), msg);
}

// R5 integration: /bg prune --yes removes the deletable set (re-deriving live state), skips
// a live job, audits one line per removal, and is idempotent.
async function pruneYesExecutesReDerivesAndAudits(url) {
	const { commands } = await loadExtension(url);
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-bg-prune-yes-"));
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
	check("prune-yes: a second pass is idempotent (deletes 0)", /Pruned 0 /.test(msg2), msg2);
	check(
		"prune-yes: idempotent pass writes no new audit lines",
		(await fs.readFile(path.join(runsRoot, ".audit.jsonl"), "utf8").catch(() => ""))
			.trim()
			.split("\n")
			.filter(Boolean).length === 2,
	);
}

async function logStreamErrorsAreContained(url) {
	const mod = await loadModule(url);
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
	check(
		"guard: records a log-stream-error event",
		/"event":"log-stream-error"/.test(events) && /boom-guarded/.test(events),
		events.slice(0, 200),
	);
}

async function atomicWriteCleansTempOnRenameFailure(url) {
	const mod = await loadModule(url);
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

async function descriptionListsPreviewSubcommand(url) {
	const { commands } = await loadExtension(url);
	const desc = commands.get("bg")?.description || "";
	check("description: lists the preview subcommand", /\bpreview\b/.test(desc), desc);
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
	const mod = await loadModule(url);
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
	check(
		"backpressure: source pauses while sink is full",
		source.isPaused() === true,
		`isPaused=${source.isPaused()}`,
	);
	release();
	await new Promise((r) => setTimeout(r, 30));
	check(
		"backpressure: source resumes after sink drains",
		source.isPaused() === false,
		`isPaused=${source.isPaused()}`,
	);
	source.destroy();
	slow.destroy();
}

async function backpressureRecoversWhenSinkDies(url) {
	const mod = await loadModule(url);
	const pipe = mod.pipeWithBackpressure;
	check("backpressure-death: pipeWithBackpressure is exported", typeof pipe === "function", typeof pipe);
	if (typeof pipe !== "function") return;

	const source = new PassThrough();
	// A sink whose write callback is never invoked -> stays full and never drains.
	const slow = new Writable({
		highWaterMark: 1,
		write() {
			/* withhold cb: permanently full */
		},
	});
	pipe(source, [slow]);
	source.write(Buffer.from("a".repeat(4096)));
	await new Promise((r) => setTimeout(r, 30));
	check(
		"backpressure-death: source pauses while sink is full",
		source.isPaused() === true,
		`isPaused=${source.isPaused()}`,
	);

	// The sink dies without ever draining. The source must resume rather than stay
	// paused forever (which would block the child and leave the job stuck running).
	slow.destroy();
	await new Promise((r) => setTimeout(r, 30));
	check(
		"backpressure-death: source resumes after the sink dies (no permanent freeze)",
		source.isPaused() === false,
		`isPaused=${source.isPaused()}`,
	);
	source.destroy();
}

async function writeCapStopsAndMarksLog(url) {
	const mod = await loadModule(url);
	const pipe = mod.pipeWithBackpressure;
	check("write-cap: pipeWithBackpressure is exported", typeof pipe === "function", typeof pipe);
	if (typeof pipe !== "function") return;

	const source = new PassThrough();
	const chunks = [];
	const sink = new Writable({
		write(chunk, _enc, cb) {
			chunks.push(Buffer.from(chunk));
			cb();
		},
	});
	const cap = 10;
	pipe(source, [sink], cap);
	source.write(Buffer.from("a".repeat(8))); // under cap
	source.write(Buffer.from("b".repeat(8))); // crosses cap -> partial + marker
	source.write(Buffer.from("c".repeat(8))); // fully dropped once capped
	await new Promise((r) => setTimeout(r, 30));

	const text = Buffer.concat(chunks).toString("utf8");
	const payload = text.replace(/\n?\[log capped at 10 bytes\]\n?/g, ""); // strip marker (it contains 'c')
	check(
		"write-cap: emits exactly one capped marker",
		(text.match(/\[log capped at 10 bytes\]/g) || []).length === 1,
		text,
	);
	check("write-cap: drops payload once capped", !payload.includes("c"), payload);
	check("write-cap: payload bytes do not exceed the cap", payload.length <= cap, `payloadBytes=${payload.length}`);
	source.destroy();
	sink.destroy();
}

async function jobFinishedGuardRejectsCancel(url) {
	const mod = await loadModule(url);
	const isFinished = mod.isJobFinished;
	check("cancel-guard: isJobFinished is exported", typeof isFinished === "function", typeof isFinished);
	if (typeof isFinished !== "function") return;
	// A finished job must not be re-signalled (avoids mislabel + stray signal to a reaped PID).
	check(
		"cancel-guard: finalized job is finished",
		isFinished({ finalized: true, child: { exitCode: null, signalCode: null } }) === true,
	);
	check(
		"cancel-guard: exited job (exitCode set) is finished",
		isFinished({ finalized: false, child: { exitCode: 0, signalCode: null } }) === true,
	);
	check(
		"cancel-guard: signalled job is finished",
		isFinished({ finalized: false, child: { exitCode: null, signalCode: "SIGTERM" } }) === true,
	);
	check(
		"cancel-guard: live running job is NOT finished",
		isFinished({ finalized: false, child: { exitCode: null, signalCode: null } }) === false,
	);
}

async function finalizeRejectionIsContained(url) {
	const mod = await loadModule(url);
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
			status: {
				jobId: `job-${label}`,
				state: "running",
				updatedAt: new Date().toISOString(),
				cancelRequested: false,
			},
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
	check(
		"mode: /bg start rejected outside TUI/RPC",
		/Cannot \/bg start outside/.test(ctx._notes.at(-1)?.msg || ""),
		ctx._notes.at(-1)?.msg,
	);
	check("mode: rejected start creates no artifacts", !existsSync(path.join(cwd, ".pi")));
}

async function main() {
	const { url } = await buildBg();
	await realStartCompletesAndLogs(url);
	await failureIsRecorded(url);
	await fastExitDoesNotRegressToRunning(url);
	await commandWhitespaceIsPreserved(url);
	await cancelStopsActiveJob(url);
	await cancelEscalatesToSigkill(url);
	await orphanedPidIsLabeledNotKilled(url);
	await interruptedAndStaleStatesAreDerived(url);
	await livenessProbeClassifiesPids(url);
	await processStartIdCapturesIdentity(url);
	await reconcileRewritesDeadRunningJobs(url);
	await verifyProcessIdentityDetectsReuse(url);
	await identityDefeatsPidReuse(url);
	await cancelSignalsVerifiedOrphan(url);
	await cancelRefusesReusedPid(url);
	await deleteGateReDerivesLiveState(url);
	await removeRunDirRevalidatesBeforeRm(url);
	await pruneFlagAndSizeHelpers(url);
	await prunePreviewListsCandidatesWithoutDeleting(url);
	await pruneYesExecutesReDerivesAndAudits(url);
	await logStreamErrorsAreContained(url);
	await jobFinishedGuardRejectsCancel(url);
	await finalizeRejectionIsContained(url);
	await backpressurePausesSource(url);
	await backpressureRecoversWhenSinkDies(url);
	await writeCapStopsAndMarksLog(url);
	await descriptionListsPreviewSubcommand(url);
	await atomicWriteCleansTempOnRenameFailure(url);
	await startSurfacesFilesystemErrors(url);
	await modeGateRejectsStart(url);

	console.log(`\n${counts.passed} passed, ${counts.failed} failed`);
	if (counts.failed) {
		console.error(counts.failures.join("\n"));
		process.exit(1);
	}
}

main().catch((err) => {
	console.error(err?.stack || err);
	process.exit(1);
});
