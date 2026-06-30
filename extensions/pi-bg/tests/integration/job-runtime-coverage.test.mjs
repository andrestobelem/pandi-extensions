#!/usr/bin/env node
/**
 * Characterization coverage for extensions/pi-bg/job-runtime.ts.
 *
 * Targets behaviors the existing bg-jobs.test.mjs leaves uncovered: writeStatus
 * serialization, pipeWithBackpressure null-source short-circuit + multi-sink
 * coordination/independent caps, finalizeJob state derivation + idempotency +
 * cancelTimer clearing, killRuntime's finished/no-pid/posix-group branches, and
 * signalProcessGroup's POSIX negative-pid group kill.
 *
 * job-runtime.ts is bundled DIRECTLY (not via index.ts) because killRuntime and
 * signalProcessGroup are not re-exported from index.ts. storage.ts (pulled in)
 * imports runtime SDK symbols, so the sdk stub is required.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { buildExtension, createChecker, loadModule, sdkStub } from "../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

const { check, counts } = createChecker();
const noop = () => {};
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

async function buildRuntime() {
	const { url } = await buildExtension({
		name: "pi-bg-job-runtime-coverage",
		src: path.join(REPO_ROOT, "extensions", "pi-bg", "job-runtime.ts"),
		outName: "job-runtime.mjs",
		stubs: { sdk: (dir) => sdkStub(dir) },
		npx: "--no-install",
	});
	return url;
}

async function makeRunDir(label) {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), `pi-bg-jr-${label}-`));
	const runDir = path.join(cwd, "run");
	await fs.mkdir(runDir, { recursive: true });
	return runDir;
}

function makeRuntime(label, runDir, { child, cancelRequested = false } = {}) {
	return {
		jobId: `job-${label}`,
		runDir,
		command: "x",
		child: child ?? { exitCode: null, signalCode: null },
		status: {
			jobId: `job-${label}`,
			state: "running",
			updatedAt: new Date(0).toISOString(),
			cancelRequested,
		},
		stdoutStream: { end: noop },
		stderrStream: { end: noop },
		combinedStream: { end: noop },
		finalized: false,
	};
}

async function readJson(file) {
	return JSON.parse(await fs.readFile(file, "utf8"));
}

// --- writeStatus: merges patch + updatedAt, serializes via statusWriteChain ---
async function writeStatusSerializes(mod) {
	const writeStatus = mod.writeStatus;
	check("writeStatus: exported", typeof writeStatus === "function", typeof writeStatus);
	if (typeof writeStatus !== "function") return;
	const runDir = await makeRunDir("writestatus");
	const rt = makeRuntime("ws", runDir);
	rt.status = { jobId: "job-ws", state: "starting", updatedAt: new Date(0).toISOString(), exitCode: 5 };

	const p1 = writeStatus(rt, { state: "starting" });
	const u1 = rt.status.updatedAt; // set synchronously before first await
	const p2 = writeStatus(rt, { state: "running" });
	const u2 = rt.status.updatedAt;
	await Promise.all([p1, p2]);

	check("writeStatus: updatedAt is monotonic across queued writes", u2 >= u1, JSON.stringify({ u1, u2 }));
	const onDisk = await readJson(path.join(runDir, "status.json"));
	check("writeStatus: last queued patch wins on disk (chain serialized)", onDisk.state === "running", JSON.stringify(onDisk));
	check("writeStatus: merges existing fields not in the patch", onDisk.exitCode === 5, JSON.stringify(onDisk));
	check("writeStatus: stamps a fresh updatedAt", typeof onDisk.updatedAt === "string" && onDisk.updatedAt > new Date(0).toISOString(), onDisk.updatedAt);
}

// --- pipeWithBackpressure: null/undefined source short-circuits ---
async function pipeNullSourceShortCircuits(mod) {
	const pipe = mod.pipeWithBackpressure;
	if (typeof pipe !== "function") return check("pipe-null: exported", false, typeof pipe);
	let writes = 0;
	const sink = new Writable({
		write(_c, _e, cb) {
			writes += 1;
			cb();
		},
	});
	let threw = false;
	try {
		pipe(null, [sink]);
		pipe(undefined, [sink]);
	} catch {
		threw = true;
	}
	check("pipe-null: returns without throwing on null/undefined source", !threw);
	check("pipe-null: attaches no drain listener to the sink (no wiring)", sink.listenerCount("drain") === 0, String(sink.listenerCount("drain")));
	check("pipe-null: no writes occur", writes === 0, String(writes));
	sink.destroy();
}

// --- pipeWithBackpressure: multiple sinks coordinate (resume only after EVERY sink drains) ---
async function pipeMultiSinkCoordination(mod) {
	const pipe = mod.pipeWithBackpressure;
	if (typeof pipe !== "function") return check("pipe-multi: exported", false, typeof pipe);
	const source = new PassThrough();
	let cbA = null;
	let cbB = null;
	const slowA = new Writable({
		highWaterMark: 1,
		write(_c, _e, cb) {
			cbA = cb;
		},
	});
	const slowB = new Writable({
		highWaterMark: 1,
		write(_c, _e, cb) {
			cbB = cb;
		},
	});
	pipe(source, [slowA, slowB]);
	source.write(Buffer.from("a".repeat(4096)));
	await tick();
	check("pipe-multi: source pauses while both sinks are full", source.isPaused() === true, `isPaused=${source.isPaused()}`);
	// Release only slowA -> the other sink still needs drain, so the source stays paused.
	if (cbA) cbA();
	await tick();
	check("pipe-multi: still paused after only one sink drains", source.isPaused() === true, `isPaused=${source.isPaused()}`);
	// Release slowB -> every sink has drained, source resumes.
	if (cbB) cbB();
	await tick();
	check("pipe-multi: resumes only after EVERY sink drains", source.isPaused() === false, `isPaused=${source.isPaused()}`);
	source.destroy();
	slowA.destroy();
	slowB.destroy();
}

// --- pipeWithBackpressure: independent per-sink byte caps ---
async function pipeIndependentCaps(mod) {
	const pipe = mod.pipeWithBackpressure;
	if (typeof pipe !== "function") return check("pipe-caps: exported", false, typeof pipe);
	const source = new PassThrough();
	const bufA = [];
	const bufB = [];
	const sinkA = new Writable({
		write(c, _e, cb) {
			bufA.push(Buffer.from(c));
			cb();
		},
	});
	const sinkB = new Writable({
		write(c, _e, cb) {
			bufB.push(Buffer.from(c));
			cb();
		},
	});
	const cap = 10;
	pipe(source, [sinkA, sinkB], cap);
	source.write(Buffer.from("a".repeat(8))); // under cap
	source.write(Buffer.from("b".repeat(8))); // crosses cap
	source.write(Buffer.from("c".repeat(8))); // dropped once capped
	await tick();
	const textA = Buffer.concat(bufA).toString("utf8");
	const textB = Buffer.concat(bufB).toString("utf8");
	const markers = (t) => (t.match(/\[log capped at 10 bytes\]/g) || []).length;
	check("pipe-caps: sink A gets exactly one cap marker", markers(textA) === 1, textA);
	check("pipe-caps: sink B gets exactly one cap marker (independent)", markers(textB) === 1, textB);
	check("pipe-caps: payload bytes per sink do not exceed the cap", textA.replace(/\n?\[log capped at 10 bytes\]\n?/g, "").length <= cap && textB.replace(/\n?\[log capped at 10 bytes\]\n?/g, "").length <= cap, JSON.stringify({ a: textA.length, b: textB.length }));
	source.destroy();
	sinkA.destroy();
	sinkB.destroy();
}

// --- finalizeJob: state derivation ---
async function finalizeStateDerivation(mod) {
	const finalizeJob = mod.finalizeJob;
	if (typeof finalizeJob !== "function") return check("finalize-derive: exported", false, typeof finalizeJob);

	// error -> failed (records error.message; finish event includes it)
	const errDir = await makeRunDir("err");
	const errRt = makeRuntime("err", errDir);
	await finalizeJob(errRt, null, null, new Error("spawn EACCES"));
	const errStatus = await readJson(path.join(errDir, "status.json"));
	check("finalize-derive: error -> state failed", errStatus.state === "failed", JSON.stringify(errStatus));
	check("finalize-derive: error message recorded on status", errStatus.error === "spawn EACCES", JSON.stringify(errStatus));
	const errEvents = await fs.readFile(path.join(errDir, "events.jsonl"), "utf8");
	check("finalize-derive: finish event includes the error message", /"event":"finish"/.test(errEvents) && /spawn EACCES/.test(errEvents), errEvents.slice(-200));

	// exitCode 0, no error, not cancelled -> completed
	const okDir = await makeRunDir("ok");
	const okRt = makeRuntime("ok", okDir);
	await finalizeJob(okRt, 0, null);
	const okStatus = await readJson(path.join(okDir, "status.json"));
	check("finalize-derive: exit 0 -> completed", okStatus.state === "completed", JSON.stringify(okStatus));

	// non-zero exit -> failed
	const failDir = await makeRunDir("fail");
	const failRt = makeRuntime("fail", failDir);
	await finalizeJob(failRt, 7, null);
	const failStatus = await readJson(path.join(failDir, "status.json"));
	check("finalize-derive: non-zero exit -> failed", failStatus.state === "failed" && failStatus.exitCode === 7, JSON.stringify(failStatus));

	// cancelRequested wins even on exit 0
	const cancelDir = await makeRunDir("cancel");
	const cancelRt = makeRuntime("cancel", cancelDir, { cancelRequested: true });
	await finalizeJob(cancelRt, 0, null);
	const cancelStatus = await readJson(path.join(cancelDir, "status.json"));
	check("finalize-derive: cancelRequested overrides exit 0 -> cancelled", cancelStatus.state === "cancelled", JSON.stringify(cancelStatus));
}

// --- finalizeJob: idempotency + cancelTimer cleared ---
async function finalizeIdempotentAndClearsTimer(mod) {
	const finalizeJob = mod.finalizeJob;
	if (typeof finalizeJob !== "function") return check("finalize-idem: exported", false, typeof finalizeJob);
	const runDir = await makeRunDir("idem");
	const rt = makeRuntime("idem", runDir);
	let fired = false;
	rt.cancelTimer = setTimeout(() => {
		fired = true;
	}, 40);

	await finalizeJob(rt, 0, null);
	check("finalize-idem: first call marks finalized", rt.finalized === true);
	await finalizeJob(rt, 7, null); // must be a no-op

	const status = await readJson(path.join(runDir, "status.json"));
	check("finalize-idem: status stays completed after a second call", status.state === "completed" && status.exitCode === 0, JSON.stringify(status));
	const events = await fs.readFile(path.join(runDir, "events.jsonl"), "utf8");
	const finishCount = (events.match(/"event":"finish"/g) || []).length;
	check("finalize-idem: exactly one finish event written", finishCount === 1, String(finishCount));

	await tick(80);
	check("finalize-idem: cancelTimer was cleared (callback never fired)", fired === false);
}

// --- killRuntime: finished job is a no-op; no-pid live job falls back to child.kill ---
async function killRuntimeBranches(mod) {
	const killRuntime = mod.killRuntime;
	if (typeof killRuntime !== "function") return check("kill: exported", false, typeof killRuntime);

	// Finished child (exitCode set) -> returns early, never signals.
	let finishedSig = "untouched";
	const finished = {
		finalized: false,
		child: { exitCode: 0, signalCode: null, pid: 999999, kill: (s) => (finishedSig = s) },
	};
	killRuntime(finished, "SIGTERM");
	check("kill: finished job is not re-signalled (child.kill untouched)", finishedSig === "untouched", String(finishedSig));

	// Live job with no pid -> falls back to child.kill(signal).
	let noPidSig = null;
	const noPid = {
		finalized: false,
		child: { exitCode: null, signalCode: null, pid: undefined, kill: (s) => (noPidSig = s) },
	};
	killRuntime(noPid, "SIGKILL");
	check("kill: no-pid live job falls back to child.kill(signal)", noPidSig === "SIGKILL", String(noPidSig));
}

// --- killRuntime (POSIX): a real pid signals the group then returns (no double kill) ---
async function killRuntimePosixGroup(mod) {
	if (process.platform === "win32") {
		check("kill-posix: group-signal path exercised on POSIX only (skipped on win32)", true);
		return;
	}
	const killRuntime = mod.killRuntime;
	if (typeof killRuntime !== "function") return check("kill-posix: exported", false, typeof killRuntime);
	const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { detached: true, stdio: "ignore" });
	child.unref();
	await tick(150);
	let directKillSig = null;
	const rt = {
		finalized: false,
		child: { exitCode: null, signalCode: null, pid: child.pid, kill: (s) => (directKillSig = s) },
	};
	try {
		killRuntime(rt, "SIGTERM");
		check("kill-posix: child.kill NOT called after group signal (no double kill)", directKillSig === null, String(directKillSig));
		const dead = await waitDead(child.pid);
		check("kill-posix: the detached group was actually signalled", dead === true);
	} finally {
		try {
			process.kill(-child.pid, "SIGKILL");
		} catch {
			/* group already gone */
		}
		try {
			process.kill(child.pid, "SIGKILL");
		} catch {
			/* child already gone */
		}
	}
}

// --- signalProcessGroup (POSIX): negative-pid kill targets the detached group ---
async function signalProcessGroupPosix(mod) {
	if (process.platform === "win32") {
		check("group-posix: negative-pid group kill exercised on POSIX only (skipped on win32)", true);
		return;
	}
	const signalProcessGroup = mod.signalProcessGroup;
	if (typeof signalProcessGroup !== "function") return check("group-posix: exported", false, typeof signalProcessGroup);
	// A detached leader that forks a grandchild in the SAME process group; both must die
	// from a single negative-pid group signal (distinguishing it from process.kill(pid)).
	const code =
		"const cp=require('node:child_process');" +
		"const g=cp.spawn(process.execPath,['-e','setTimeout(()=>{},60000)'],{stdio:'ignore'});" +
		"process.stdout.write(String(g.pid));" +
		"setTimeout(()=>{},60000);";
	const child = spawn(process.execPath, ["-e", code], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
	child.unref();
	let gpidText = "";
	child.stdout.on("data", (d) => (gpidText += d.toString()));
	const grandPid = await waitFor("grandchild pid", async () => {
		const n = Number.parseInt(gpidText, 10);
		return Number.isInteger(n) && n > 0 ? n : false;
	});
	try {
		check("group-posix: both child and grandchild are alive before signal", isAlive(child.pid) && isAlive(grandPid), JSON.stringify({ c: child.pid, g: grandPid }));
		signalProcessGroup(child.pid, "SIGTERM");
		const childDead = await waitDead(child.pid);
		const grandDead = await waitDead(grandPid);
		check("group-posix: signal reaches the whole group (child gone)", childDead === true);
		check("group-posix: signal reaches the whole group (grandchild gone too)", grandDead === true);
	} finally {
		for (const pid of [child.pid, grandPid]) {
			try {
				process.kill(-pid, "SIGKILL");
			} catch {
				/* gone */
			}
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				/* gone */
			}
		}
	}
}

function isAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitDead(pid) {
	return waitFor(`pid ${pid} dead`, async () => (isAlive(pid) ? false : true), { timeoutMs: 8000 });
}

async function waitFor(label, fn, { timeoutMs = 6000, intervalMs = 25 } = {}) {
	const deadline = Date.now() + timeoutMs;
	let last;
	while (Date.now() < deadline) {
		last = await fn();
		if (last) return last;
		await tick(intervalMs);
	}
	throw new Error(`Timed out waiting for ${label}`);
}

async function main() {
	const url = await buildRuntime();
	const mod = await loadModule(url);
	await writeStatusSerializes(mod);
	await pipeNullSourceShortCircuits(mod);
	await pipeMultiSinkCoordination(mod);
	await pipeIndependentCaps(mod);
	await finalizeStateDerivation(mod);
	await finalizeIdempotentAndClearsTimer(mod);
	await killRuntimeBranches(mod);
	await killRuntimePosixGroup(mod);
	await signalProcessGroupPosix(mod);

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
