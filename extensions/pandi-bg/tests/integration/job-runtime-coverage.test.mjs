#!/usr/bin/env node
/**
 * Cobertura de caracterización para extensions/pandi-bg/job-runtime.ts.
 *
 * Apunta a comportamientos que bg-jobs.test.mjs deja sin cubrir: serialización de writeStatus,
 * short-circuit de fuente null en pipeWithBackpressure + coordinación multi-sink/caps
 * independientes, derivación de estado + idempotencia + limpieza de cancelTimer en finalizeJob,
 * ramas finished/no-pid/posix-group de killRuntime, y kill de grupo con pid negativo POSIX de
 * signalProcessGroup.
 *
 * job-runtime.ts se bundlea DIRECTAMENTE (no vía index.ts) porque killRuntime y
 * signalProcessGroup no se reexportan desde index.ts. storage.ts (arrastrado) importa símbolos
 * del SDK runtime, así que se requiere el stub sdk.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { buildExtension, createChecker, loadModule, sdkStub } from "../../../shared/test/harness.mjs";
import { readJson, waitFor } from "./bg-test-support.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

const { check, counts } = createChecker();
const noop = () => {};

async function flushStreamTurn() {
	await new Promise((resolve) => setImmediate(resolve));
}

async function buildRuntime() {
	const { url } = await buildExtension({
		name: "pi-bg-job-runtime-coverage",
		src: path.join(REPO_ROOT, "extensions", "pandi-bg", "job-runtime.ts"),
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

// --- writeStatus: mergea patch + updatedAt, serializa vía statusWriteChain ---
async function writeStatusSerializes(mod) {
	const writeStatus = mod.writeStatus;
	check("writeStatus: exported", typeof writeStatus === "function", typeof writeStatus);
	if (typeof writeStatus !== "function") return;
	const runDir = await makeRunDir("writestatus");
	const rt = makeRuntime("ws", runDir);
	rt.status = { jobId: "job-ws", state: "starting", updatedAt: new Date(0).toISOString(), exitCode: 5 };

	const p1 = writeStatus(rt, { state: "starting" });
	const u1 = rt.status.updatedAt; // seteado sincrónicamente antes del primer await
	const p2 = writeStatus(rt, { state: "running" });
	const u2 = rt.status.updatedAt;
	await Promise.all([p1, p2]);

	check("writeStatus: updatedAt is monotonic across queued writes", u2 >= u1, JSON.stringify({ u1, u2 }));
	const onDisk = await readJson(path.join(runDir, "status.json"));
	check(
		"writeStatus: last queued patch wins on disk (chain serialized)",
		onDisk.state === "running",
		JSON.stringify(onDisk),
	);
	check("writeStatus: merges existing fields not in the patch", onDisk.exitCode === 5, JSON.stringify(onDisk));
	check(
		"writeStatus: stamps a fresh updatedAt",
		typeof onDisk.updatedAt === "string" && onDisk.updatedAt > new Date(0).toISOString(),
		onDisk.updatedAt,
	);
}

// --- pipeWithBackpressure: fuente null/undefined hace short-circuit ---
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
	check(
		"pipe-null: attaches no drain listener to the sink (no wiring)",
		sink.listenerCount("drain") === 0,
		String(sink.listenerCount("drain")),
	);
	check("pipe-null: no writes occur", writes === 0, String(writes));
	sink.destroy();
}

// --- pipeWithBackpressure: múltiples sinks coordinan (resume solo tras drenar CADA sink) ---
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
	check(
		"pipe-multi: source pauses while both sinks are full",
		source.isPaused() === true,
		`isPaused=${source.isPaused()}`,
	);
	// Libera solo slowA -> el otro sink aún necesita drain, así que la fuente sigue pausada.
	if (cbA) cbA();
	await flushStreamTurn();
	check(
		"pipe-multi: still paused after only one sink drains",
		source.isPaused() === true,
		`isPaused=${source.isPaused()}`,
	);
	// Libera slowB -> todos los sinks drenaron, la fuente reanuda.
	if (cbB) cbB();
	await flushStreamTurn();
	check(
		"pipe-multi: resumes only after EVERY sink drains",
		source.isPaused() === false,
		`isPaused=${source.isPaused()}`,
	);
	source.destroy();
	slowA.destroy();
	slowB.destroy();
}

// --- pipeWithBackpressure: caps de bytes independientes por sink ---
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
	source.write(Buffer.from("a".repeat(8))); // bajo cap
	source.write(Buffer.from("b".repeat(8))); // cruza el cap
	source.write(Buffer.from("c".repeat(8))); // descartado tras llegar al cap
	const textA = Buffer.concat(bufA).toString("utf8");
	const textB = Buffer.concat(bufB).toString("utf8");
	const markers = (t) => (t.match(/\[log topado en 10 bytes\]/g) || []).length;
	check("pipe-caps: sink A gets exactly one cap marker", markers(textA) === 1, textA);
	check("pipe-caps: sink B gets exactly one cap marker (independent)", markers(textB) === 1, textB);
	check(
		"pipe-caps: payload bytes per sink do not exceed the cap",
		textA.replace(/\n?\[log topado en 10 bytes\]\n?/g, "").length <= cap &&
			textB.replace(/\n?\[log topado en 10 bytes\]\n?/g, "").length <= cap,
		JSON.stringify({ a: textA.length, b: textB.length }),
	);
	source.destroy();
	sinkA.destroy();
	sinkB.destroy();
}

// --- finalizeJob: derivación de estado ---
async function finalizeStateDerivation(mod) {
	const finalizeJob = mod.finalizeJob;
	if (typeof finalizeJob !== "function") return check("finalize-derive: exported", false, typeof finalizeJob);

	// error -> failed (registra error.message; el evento finish lo incluye)
	const errDir = await makeRunDir("err");
	const errRt = makeRuntime("err", errDir);
	await finalizeJob(errRt, null, null, new Error("spawn EACCES"));
	const errStatus = await readJson(path.join(errDir, "status.json"));
	check("finalize-derive: error -> state failed", errStatus.state === "failed", JSON.stringify(errStatus));
	check(
		"finalize-derive: error message recorded on status",
		errStatus.error === "spawn EACCES",
		JSON.stringify(errStatus),
	);
	const errEvents = await fs.readFile(path.join(errDir, "events.jsonl"), "utf8");
	check(
		"finalize-derive: finish event includes the error message",
		/"event":"finish"/.test(errEvents) && /spawn EACCES/.test(errEvents),
		errEvents.slice(-200),
	);

	// exitCode 0, sin error, no cancelado -> completed
	const okDir = await makeRunDir("ok");
	const okRt = makeRuntime("ok", okDir);
	await finalizeJob(okRt, 0, null);
	const okStatus = await readJson(path.join(okDir, "status.json"));
	check("finalize-derive: exit 0 -> completed", okStatus.state === "completed", JSON.stringify(okStatus));

	// salida no cero -> failed
	const failDir = await makeRunDir("fail");
	const failRt = makeRuntime("fail", failDir);
	await finalizeJob(failRt, 7, null);
	const failStatus = await readJson(path.join(failDir, "status.json"));
	check(
		"finalize-derive: non-zero exit -> failed",
		failStatus.state === "failed" && failStatus.exitCode === 7,
		JSON.stringify(failStatus),
	);

	// cancelRequested gana incluso con exit 0
	const cancelDir = await makeRunDir("cancel");
	const cancelRt = makeRuntime("cancel", cancelDir, { cancelRequested: true });
	await finalizeJob(cancelRt, 0, null);
	const cancelStatus = await readJson(path.join(cancelDir, "status.json"));
	check(
		"finalize-derive: cancelRequested overrides exit 0 -> cancelled",
		cancelStatus.state === "cancelled",
		JSON.stringify(cancelStatus),
	);
}

// --- finalizeJob: cleanup corre incluso cuando una escritura status/event lanza ---
// finalizeJob setea finalized=true, luego espera writeStatus + appendEvent, luego remueve el job
// de activeJobs y cierra los log streams. Si una escritura lanza (disco lleno, límite de FD,
// runDir faltante), el cleanup IGUAL debe correr; de lo contrario el job queda medio finalizado:
// stream fds filtrados y la corrida trabada. Ambos pasos de cleanup comparten un finally; cerrar
// los streams es el pin observable.
async function finalizeClosesStreamsWhenWriteFails(mod) {
	const finalizeJob = mod.finalizeJob;
	if (typeof finalizeJob !== "function") return check("finalize-cleanup: exported", false, typeof finalizeJob);

	// Un runDir que NO existe hace que atomicWriteJson (writeStatus) lance ENOENT.
	const badRunDir = path.join(os.tmpdir(), "pi-bg-finalize-nonexistent-dir-xyz", "run");
	const ended = { stdout: false, stderr: false, combined: false };
	const rt = makeRuntime("cleanup", badRunDir, {});
	rt.stdoutStream = { end: () => (ended.stdout = true) };
	rt.stderrStream = { end: () => (ended.stderr = true) };
	rt.combinedStream = { end: () => (ended.combined = true) };

	let threw = false;
	try {
		await finalizeJob(rt, 0, null);
	} catch {
		threw = true;
	}
	check("finalize-cleanup: a failing status write still rejects the promise", threw === true);
	check(
		"finalize-cleanup: all log streams are closed despite the write failure (no fd leak)",
		ended.stdout && ended.stderr && ended.combined,
		JSON.stringify(ended),
	);
}

// --- finalizeJob: idempotencia + cancelTimer limpiado ---
async function finalizeIdempotentAndClearsTimer(mod) {
	const finalizeJob = mod.finalizeJob;
	if (typeof finalizeJob !== "function") return check("finalize-idem: exported", false, typeof finalizeJob);
	const runDir = await makeRunDir("idem");
	const rt = makeRuntime("idem", runDir);
	let fired = false;
	rt.cancelTimer = setTimeout(() => {
		fired = true;
	}, 10_000);
	const realClearTimeout = globalThis.clearTimeout;
	let clearedTimer = false;
	globalThis.clearTimeout = (timer) => {
		if (timer === rt.cancelTimer) clearedTimer = true;
		return realClearTimeout(timer);
	};

	try {
		await finalizeJob(rt, 0, null);
	} finally {
		globalThis.clearTimeout = realClearTimeout;
		realClearTimeout(rt.cancelTimer);
	}
	check("finalize-idem: first call marks finalized", rt.finalized === true);
	await finalizeJob(rt, 7, null); // debe ser no-op

	const status = await readJson(path.join(runDir, "status.json"));
	check(
		"finalize-idem: status stays completed after a second call",
		status.state === "completed" && status.exitCode === 0,
		JSON.stringify(status),
	);
	const events = await fs.readFile(path.join(runDir, "events.jsonl"), "utf8");
	const finishCount = (events.match(/"event":"finish"/g) || []).length;
	check("finalize-idem: exactly one finish event written", finishCount === 1, String(finishCount));

	check("finalize-idem: cancelTimer was cleared", clearedTimer === true);
	check("finalize-idem: cleared cancelTimer callback never fired", fired === false);
}

// --- killRuntime: job finalized es no-op; job vivo sin pid cae a child.kill ---
async function killRuntimeBranches(mod) {
	const killRuntime = mod.killRuntime;
	if (typeof killRuntime !== "function") return check("kill: exported", false, typeof killRuntime);

	// Job FINALIZED -> retorna temprano, nunca envía señal (su pid puede estar reaped/reused).
	// NOTE: exitCode solo NO debe disparar esta rama; con shell:true el child directo puede ser
	// solo la shell mientras su grupo sigue vivo (issue #9); ese caso live-group queda pineado por
	// killRuntimeExitedShellSignalsSurvivors abajo.
	let finishedSig = "untouched";
	const finished = {
		finalized: true,
		child: { exitCode: 0, signalCode: null, pid: 999999, kill: (s) => (finishedSig = s) },
	};
	killRuntime(finished, "SIGTERM");
	check(
		"kill: finalized job is not re-signalled (child.kill untouched)",
		finishedSig === "untouched",
		String(finishedSig),
	);

	// Job vivo sin pid -> cae a child.kill(signal).
	let noPidSig = null;
	const noPid = {
		finalized: false,
		child: { exitCode: null, signalCode: null, pid: undefined, kill: (s) => (noPidSig = s) },
	};
	killRuntime(noPid, "SIGKILL");
	check("kill: no-pid live job falls back to child.kill(signal)", noPidSig === "SIGKILL", String(noPidSig));
}

// --- killRuntime (POSIX): un child directo salido NO bloquea la señal de grupo (issue #9) ---
async function killRuntimeExitedShellSignalsSurvivors(mod) {
	if (process.platform === "win32") {
		check("kill-exited-shell: POSIX group semantics (skipped on win32)", true);
		return;
	}
	const killRuntime = mod.killRuntime;
	if (typeof killRuntime !== "function") return check("kill-exited-shell: exported", false, typeof killRuntime);
	// Un leader detached forkea un sobreviviente dentro de su process group y SALE, espejando a
	// dash bajo shell:true cuando forkea el trabajo real (issue #9): el child directo del runtime
	// tiene exitCode seteado mientras un miembro del grupo sigue vivo.
	const code =
		"const cp=require('node:child_process');" +
		"const g=cp.spawn(process.execPath,['-e','setTimeout(()=>{},60000)'],{stdio:'ignore'});" +
		"g.unref();" + // el handle del child no debe mantener vivo el event loop del leader: el leader SALE
		"process.stdout.write(String(g.pid));";
	const child = spawn(process.execPath, ["-e", code], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
	child.unref();
	let gpidText = "";
	child.stdout.on("data", (d) => (gpidText += d.toString()));
	const grandPid = await waitFor("group survivor pid", async () => {
		const n = Number.parseInt(gpidText, 10);
		return Number.isInteger(n) && n > 0 ? n : false;
	});
	try {
		await waitFor("leader exited", async () => !isAlive(child.pid));
		check("kill-exited-shell: survivor alive after the leader exited", isAlive(grandPid));
		let directKillSig = null;
		const rt = {
			finalized: false,
			child: { exitCode: 0, signalCode: null, pid: child.pid, kill: (s) => (directKillSig = s) },
		};
		killRuntime(rt, "SIGKILL");
		check(
			"kill-exited-shell: child.kill NOT called (group signal path)",
			directKillSig === null,
			String(directKillSig),
		);
		const dead = await waitDead(grandPid);
		check("kill-exited-shell: the group survivor was signalled (issue #9)", dead === true);
	} finally {
		try {
			process.kill(-child.pid, "SIGKILL");
		} catch {
			/* grupo ya ausente */
		}
		try {
			process.kill(grandPid, "SIGKILL");
		} catch {
			/* sobreviviente ya ausente */
		}
	}
}

// --- killRuntime (POSIX): un pid real señaliza el grupo y retorna (sin double kill) ---
async function killRuntimePosixGroup(mod) {
	if (process.platform === "win32") {
		check("kill-posix: group-signal path exercised on POSIX only (skipped on win32)", true);
		return;
	}
	const killRuntime = mod.killRuntime;
	if (typeof killRuntime !== "function") return check("kill-posix: exported", false, typeof killRuntime);
	const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { detached: true, stdio: "ignore" });
	child.unref();
	await waitFor("detached child alive", async () => isAlive(child.pid));
	let directKillSig = null;
	const rt = {
		finalized: false,
		child: { exitCode: null, signalCode: null, pid: child.pid, kill: (s) => (directKillSig = s) },
	};
	try {
		killRuntime(rt, "SIGTERM");
		check(
			"kill-posix: child.kill NOT called after group signal (no double kill)",
			directKillSig === null,
			String(directKillSig),
		);
		const dead = await waitDead(child.pid);
		check("kill-posix: the detached group was actually signalled", dead === true);
	} finally {
		try {
			process.kill(-child.pid, "SIGKILL");
		} catch {
			/* grupo ya ausente */
		}
		try {
			process.kill(child.pid, "SIGKILL");
		} catch {
			/* child ya ausente */
		}
	}
}

// --- signalProcessGroup (POSIX): kill con pid negativo apunta al grupo detached ---
async function signalProcessGroupPosix(mod) {
	if (process.platform === "win32") {
		check("group-posix: negative-pid group kill exercised on POSIX only (skipped on win32)", true);
		return;
	}
	const signalProcessGroup = mod.signalProcessGroup;
	if (typeof signalProcessGroup !== "function")
		return check("group-posix: exported", false, typeof signalProcessGroup);
	// Un leader detached que forkea un grandchild en el MISMO process group; ambos deben morir
	// por una sola señal de grupo con pid negativo (distinguiéndola de process.kill(pid)).
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
		check(
			"group-posix: both child and grandchild are alive before signal",
			isAlive(child.pid) && isAlive(grandPid),
			JSON.stringify({ c: child.pid, g: grandPid }),
		);
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
				/* ausente */
			}
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				/* ausente */
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
	return waitFor(`pid ${pid} dead`, async () => !isAlive(pid), { timeoutMs: 8000 });
}

async function main() {
	const url = await buildRuntime();
	const mod = await loadModule(url);
	await writeStatusSerializes(mod);
	await pipeNullSourceShortCircuits(mod);
	await pipeMultiSinkCoordination(mod);
	await pipeIndependentCaps(mod);
	await finalizeStateDerivation(mod);
	await finalizeClosesStreamsWhenWriteFails(mod);
	await finalizeIdempotentAndClearsTimer(mod);
	await killRuntimeBranches(mod);
	await killRuntimeExitedShellSignalsSurvivors(mod);
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
