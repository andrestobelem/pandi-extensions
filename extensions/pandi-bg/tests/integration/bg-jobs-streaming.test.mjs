#!/usr/bin/env node
/**
 * Suite partida de bg-jobs.test.mjs — log guards, backpressure, write cap, finalize.
 *
 * Ejecutar: node extensions/pandi-bg/tests/integration/bg-jobs-streaming.test.mjs
 */

import { createWriteStream } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { loadModule } from "../../../shared/test/harness.mjs";
import { createBgTestDir, flushStreamTurn, runBgScenarios, waitFor } from "./bg-test-support.mjs";

async function logStreamErrorsAreContained(url, check) {
	const mod = await loadModule(url);
	const guard = mod.guardStreamErrors;
	check("guard: guardStreamErrors is exported", typeof guard === "function", typeof guard);
	if (typeof guard !== "function") return;

	const cwd = await createBgTestDir("pi-bg-streamerr-");
	const runDir = path.join(cwd, "run");
	await fs.mkdir(runDir, { recursive: true });

	// Baseline de riesgo: un 'error' de stream sin guard lanza y crashearía el proceso host.
	const unguarded = createWriteStream(path.join(runDir, "unguarded.log"));
	let unguardedThrew = false;
	try {
		unguarded.emit("error", new Error("boom-unguarded"));
	} catch {
		unguardedThrew = true;
	}
	unguarded.destroy();
	check("guard: unguarded stream error throws (hazard reproduced)", unguardedThrew);

	// Comportamiento corregido: un 'error' de stream con guard queda contenido (no lanza) y se registra como evento.
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

async function atomicWriteCleansTempOnRenameFailure(url, check) {
	const mod = await loadModule(url);
	const atomicWriteJson = mod.atomicWriteJson;
	check("atomic: atomicWriteJson is exported", typeof atomicWriteJson === "function", typeof atomicWriteJson);
	if (typeof atomicWriteJson !== "function") return;
	const dir = await createBgTestDir("pi-bg-atomic-");
	// Hace que el target sea un directorio existente para que rename(tmp, target) falle (EISDIR).
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

async function backpressurePausesSource(url, check) {
	const mod = await loadModule(url);
	const pipe = mod.pipeWithBackpressure;
	check("backpressure: pipeWithBackpressure is exported", typeof pipe === "function", typeof pipe);
	if (typeof pipe !== "function") return;

	const source = new PassThrough();
	let release;
	const gate = new Promise((resolve) => {
		release = resolve;
	});
	// Un sink cuyo callback de write se retiene -> queda lleno y nunca drena hasta liberarlo.
	const slow = new Writable({
		highWaterMark: 1,
		write(_chunk, _enc, cb) {
			gate.then(() => cb());
		},
	});
	pipe(source, [slow]);
	source.write(Buffer.from("a".repeat(4096)));
	check("backpressure: source pauses while sink is full", source.isPaused() === true, `isPaused=${source.isPaused()}`);
	release();
	await flushStreamTurn();
	check(
		"backpressure: source resumes after sink drains",
		source.isPaused() === false,
		`isPaused=${source.isPaused()}`,
	);
	source.destroy();
	slow.destroy();
}

async function backpressureRecoversWhenSinkDies(url, check) {
	const mod = await loadModule(url);
	const pipe = mod.pipeWithBackpressure;
	check("backpressure-death: pipeWithBackpressure is exported", typeof pipe === "function", typeof pipe);
	if (typeof pipe !== "function") return;

	const source = new PassThrough();
	// Un sink cuyo callback de write nunca se invoca -> queda lleno y nunca drena.
	const slow = new Writable({
		highWaterMark: 1,
		write() {
			/* retener cb: lleno permanentemente */
		},
	});
	pipe(source, [slow]);
	source.write(Buffer.from("a".repeat(4096)));
	check(
		"backpressure-death: source pauses while sink is full",
		source.isPaused() === true,
		`isPaused=${source.isPaused()}`,
	);

	// El sink muere sin drenar nunca. La fuente debe reanudar en vez de quedar pausada para
	// siempre (lo que bloquearía al child y dejaría el job trabado en running).
	slow.destroy();
	await flushStreamTurn();
	check(
		"backpressure-death: source resumes after the sink dies (no permanent freeze)",
		source.isPaused() === false,
		`isPaused=${source.isPaused()}`,
	);
	source.destroy();
}

async function writeCapStopsAndMarksLog(url, check) {
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
	source.write(Buffer.from("a".repeat(8))); // bajo cap
	source.write(Buffer.from("b".repeat(8))); // cruza el cap -> parcial + marcador
	source.write(Buffer.from("c".repeat(8))); // descartado por completo tras llegar al cap

	const text = Buffer.concat(chunks).toString("utf8");
	const payload = text.replace(/\n?\[log topado en 10 bytes\]\n?/g, ""); // quita marcador (contiene 'c')
	check(
		"write-cap: emits exactly one capped marker",
		(text.match(/\[log topado en 10 bytes\]/g) || []).length === 1,
		text,
	);
	check("write-cap: drops payload once capped", !payload.includes("c"), payload);
	check("write-cap: payload bytes do not exceed the cap", payload.length <= cap, `payloadBytes=${payload.length}`);
	source.destroy();
	sink.destroy();
}

async function finalizeRejectionIsContained(url, check) {
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
		// Hace que status.json sea un directorio para que el rename de atomicWriteJson falle
		// -> writeStatus rechaza -> finalizeJob rechaza, reproduciendo el riesgo de crash del host.
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

	// Baseline de riesgo: finalizeJob crudo rechaza cuando falla la escritura de status. Un
	// `void finalizeJob(...)` sin guard en un handler de ciclo de vida del child escalaría esto
	// a un unhandledRejection y crashearía el proceso host de Pi.
	const bad1 = await makeBadRuntime("raw");
	let rawRejected = false;
	await finalizeJob(bad1, 0, null).catch(() => {
		rawRejected = true;
	});
	check("finalize: raw finalizeJob rejects on status-write failure (hazard reproduced)", rawRejected);

	// Comportamiento corregido: safeFinalize absorbe el rechazo (sin unhandledRejection)
	// y lo registra como evento finalize-error para observabilidad.
	const rejections = [];
	const onUnhandled = (err) => rejections.push(err);
	process.on("unhandledRejection", onUnhandled);
	const bad2 = await makeBadRuntime("safe");
	const ret = safeFinalize(bad2, 0, null);
	check("finalize: safeFinalize returns void (does not throw synchronously)", ret === undefined);
	let events = "";
	try {
		events = await waitFor("finalize-error event", async () => {
			const body = await fs.readFile(path.join(bad2.runDir, "events.jsonl"), "utf8").catch(() => "");
			return /finalize-error/.test(body) ? body : false;
		});
	} finally {
		process.off("unhandledRejection", onUnhandled);
	}
	check("finalize: safeFinalize produces no unhandled rejection", rejections.length === 0, String(rejections.length));
	check("finalize: safeFinalize records a finalize-error event", /finalize-error/.test(events), events.slice(0, 200));
}

async function main() {
	await runBgScenarios({
		name: "pi-bg-jobs-streaming",
		scenarios: [
			logStreamErrorsAreContained,
			atomicWriteCleansTempOnRenameFailure,
			backpressurePausesSource,
			backpressureRecoversWhenSinkDies,
			writeCapStopsAndMarksLog,
			finalizeRejectionIsContained,
		],
	});
}

main().catch((err) => {
	console.error(err?.stack || err);
	process.exit(1);
});
