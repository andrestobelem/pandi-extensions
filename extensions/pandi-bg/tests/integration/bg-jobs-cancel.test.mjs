#!/usr/bin/env node
/**
 * Suite partida de bg-jobs.test.mjs — cancellation, SIGKILL escalation, orphan signaling.
 *
 * Ejecutar: node extensions/pandi-bg/tests/integration/bg-jobs-cancel.test.mjs
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { loadModule } from "../../../shared/test/harness.mjs";
import {
	createBgTestDir,
	loadExtension,
	makeCtx,
	parseJobId,
	readJson,
	runBgScenarios,
	shellQuote,
	waitFor,
	waitForFile,
} from "./bg-test-support.mjs";

async function cancelStopsActiveJob(url, check) {
	const { commands } = await loadExtension(url);
	const cwd = await createBgTestDir("pi-bg-cancel-");
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
	await waitForFile("long job started", started);
	await waitFor("long job running status", async () => {
		const s = await readJson(path.join(runDir, "status.json"));
		return s.state === "running" ? s : false;
	});
	await commands.get("bg").handler(`cancel ${jobId}`, ctx);
	check(
		"cancel: reports cancellation requested",
		/Cancelación solicitada/.test(ctx._notes.at(-1)?.msg || ""),
		ctx._notes.at(-1)?.msg,
	);
	const status = await waitFor("cancelled status", async () => {
		const s = await readJson(path.join(runDir, "status.json"));
		return s.state === "cancelled" ? s : false;
	});
	check("cancel: final state is cancelled", status.state === "cancelled", JSON.stringify(status));
	check("cancel: cancelRequested recorded", status.cancelRequested === true, JSON.stringify(status));
}

async function cancelEscalatesToSigkill(url, check) {
	if (process.platform === "win32") {
		check("cancel-sigkill: skipped on win32 (taskkill path not exercised here)", true);
		return;
	}
	const { commands } = await loadExtension(url);
	const cwd = await createBgTestDir("pi-bg-sigkill-");
	const script = path.join(cwd, "ignore-sigterm.cjs");
	const started = path.join(cwd, "sigterm-started");
	// Un child que INSTALA un handler SIGTERM y sigue corriendo -> sobrevive al SIGTERM
	// inicial, así que la finalización solo ocurre cuando el grace-timer escala a SIGKILL.
	// El test cancel existente usa un child sin handler (muere con SIGTERM), así que esta
	// es la única cobertura de la ruta de cancelación más riesgosa.
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
	await waitForFile("sigterm-ignoring child started", started);
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

async function cancelReachesGroupSurvivorsAfterShellExit(url, check) {
	if (process.platform === "win32") {
		check("cancel-survivors: skipped on win32 (POSIX group semantics)", true);
		return;
	}
	// Forma del issue #9: el child DIRECTO (la shell) sale de inmediato tras mandar el trabajo
	// real a background, mientras el sobreviviente ignora SIGTERM y mantiene abiertos los log
	// pipes. En Linux CI esta misma forma de árbol aparece SIN '&' (dash forkea en vez de hacer
	// exec del comando), y dejaba jobs trabados para siempre: child.exitCode quedaba seteado,
	// así que el guard de terminado omitía cancel y la escalada a SIGKILL. Un job debe contar
	// como vivo hasta FINALIZED, y la escalada debe llegar al GROUP.
	const { commands } = await loadExtension(url);
	const cwd = await createBgTestDir("pi-bg-survivor-");
	const script = path.join(cwd, "ignore-sigterm.cjs");
	const started = path.join(cwd, "survivor-started");
	await fs.writeFile(
		script,
		`const fs = require("node:fs");\n` +
			`process.on("SIGTERM", () => { /* ignore: survive until SIGKILL */ });\n` +
			`fs.writeFileSync(process.argv[2], String(process.pid));\n` +
			`setInterval(() => {}, 1000);\n`,
	);
	const ctx = makeCtx({ cwd, trusted: true });
	// `... &`: la shell manda el worker a background (mismo process group, job control off)
	// y sale 0 de inmediato -> exitCode seteado en el runtime mientras el grupo sigue vivo.
	const command = `${shellQuote(process.execPath)} ${shellQuote(script)} ${shellQuote(started)} &`;
	await commands.get("bg").handler(`start ${command}`, ctx);
	const jobId = parseJobId(ctx._notes.at(-1)?.msg || "");
	const runDir = path.join(cwd, ".pi", "bg", "runs", jobId || "missing");
	await waitForFile("group survivor started", started);

	await commands.get("bg").handler(`cancel ${jobId}`, ctx);
	check(
		"cancel-survivors: cancel is accepted (job is live until finalized)",
		/Cancelación solicitada/.test(ctx._notes.at(-1)?.msg || ""),
		ctx._notes.at(-1)?.msg,
	);
	const status = await waitFor(
		"cancelled status after shell exit + SIGKILL escalation",
		async () => {
			const s = await readJson(path.join(runDir, "status.json"));
			return s.state === "cancelled" ? s : false;
		},
		{ timeoutMs: 8000 },
	);
	check("cancel-survivors: final state is cancelled", status.state === "cancelled", JSON.stringify(status));
	const survivorPid = Number(await fs.readFile(started, "utf8").catch(() => "0"));
	await waitFor("group survivor reaped after SIGKILL", async () => {
		try {
			process.kill(survivorPid, 0);
			return false; // sigue vivo
		} catch {
			return true;
		}
	});
	check("cancel-survivors: no orphaned group member is left running", true, `pid=${survivorPid}`);
}

async function cancelSignalsVerifiedOrphan(url, check) {
	if (process.platform === "win32") {
		check("cancel-orphan: verified-orphan signaling exercised on POSIX only (skipped on win32)", true);
		return;
	}
	const mod = await loadModule(url);
	const readStartId = mod.readProcessStartId;
	const { commands } = await loadExtension(url);
	const cwd = await createBgTestDir("pi-bg-cancel-orphan-");
	const jobId = "verified-orphan";
	const runDir = path.join(cwd, ".pi", "bg", "runs", jobId);
	await fs.mkdir(runDir, { recursive: true });
	// Un process group detached real que poseemos a nivel SO pero NO en esta sesión bg.
	const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
		detached: true,
		stdio: "ignore",
	});
	child.unref();
	const startId = await waitFor("orphan child start identity", async () => {
		const id = readStartId(child.pid);
		return typeof id === "string" && id.length > 0 ? id : false;
	});
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
			/SIGTERM/.test(msg) && /huérfano verificado/i.test(msg),
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
			/* mejor esfuerzo: el process group puede ya no existir */
		}
		try {
			process.kill(child.pid, "SIGKILL");
		} catch {
			/* mejor esfuerzo: el child puede ya no existir */
		}
	}
}

async function cancelVerifiedOrphanKeepsSurvivorNonDeletable(url, check) {
	if (process.platform === "win32") {
		check("cancel-orphan-survivor: POSIX process-group signaling skipped on win32", true);
		return;
	}
	const mod = await loadModule(url);
	const readStartId = mod.readProcessStartId;
	const { commands } = await loadExtension(url);
	const cwd = await createBgTestDir("pi-bg-cancel-orphan-survivor-");
	const jobId = "survivor-orphan";
	const runDir = path.join(cwd, ".pi", "bg", "runs", jobId);
	await fs.mkdir(runDir, { recursive: true });
	const started = path.join(cwd, "survivor-started");
	const child = spawn(
		process.execPath,
		[
			"-e",
			"const fs=require('node:fs'); process.on('SIGTERM', () => {}); fs.writeFileSync(process.argv[1], 'ready'); setTimeout(() => {}, 60000)",
			started,
		],
		{ detached: true, stdio: "ignore" },
	);
	child.unref();
	await waitForFile("survivor installed SIGTERM handler", started);
	const startId = await waitFor("survivor orphan start identity", async () => {
		const id = readStartId(child.pid);
		return typeof id === "string" && id.length > 0 ? id : false;
	});
	try {
		await fs.writeFile(
			path.join(runDir, "job.json"),
			JSON.stringify(
				{ jobId, command: "survivor", cwd, createdAt: new Date().toISOString(), artifactsDir: runDir },
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
		check("cancel-orphan-survivor: reports that process is still alive", /sigue vivo/.test(msg), msg);
		check("cancel-orphan-survivor: process is still alive after cancel", process.kill(child.pid, 0) === true);
		const status = await readJson(path.join(runDir, "status.json"));
		check(
			"cancel-orphan-survivor: status is non-terminal/non-deletable",
			status.state === "orphaned" && status.cancelRequested === true && !status.completedAt,
			JSON.stringify(status),
		);
		const events = await fs.readFile(path.join(runDir, "events.jsonl"), "utf8").catch(() => "");
		check(
			"cancel-orphan-survivor: records survived event",
			/cancel-orphan-survived/.test(events),
			events.slice(-300),
		);
	} finally {
		try {
			process.kill(-child.pid, "SIGKILL");
		} catch {
			/* best effort */
		}
		try {
			process.kill(child.pid, "SIGKILL");
		} catch {
			/* best effort */
		}
	}
}

async function cancelRefusesReusedPid(url, check) {
	const { commands } = await loadExtension(url);
	const cwd = await createBgTestDir("pi-bg-cancel-reuse-");
	const jobId = "reused-cancel";
	const runDir = path.join(cwd, ".pi", "bg", "runs", jobId);
	await fs.mkdir(runDir, { recursive: true });
	await fs.writeFile(
		path.join(runDir, "job.json"),
		JSON.stringify({ jobId, command: "x", cwd, createdAt: new Date().toISOString(), artifactsDir: runDir }, null, 2),
	);
	// Pid vivo (este proceso) pero identidad registrada stale => reutilización de pid: NO debe recibir señal.
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
		check("cancel-reuse: win32 refuses (identity unverifiable)", /rechaz/i.test(msg), msg);
	} else {
		check("cancel-reuse: refuses a reused pid and explains why", /rechaz/i.test(msg) && /reutiliz/i.test(msg), msg);
	}
}

async function jobFinishedGuardRejectsCancel(url, check) {
	const mod = await loadModule(url);
	const isFinished = mod.isJobFinished;
	check("cancel-guard: isJobFinished is exported", typeof isFinished === "function", typeof isFinished);
	if (typeof isFinished !== "function") return;
	// Un job FINALIZED no debe recibir señal de nuevo, pero un job cuyo child directo salió
	// sigue vivo: con shell:true la shell puede salir mientras su process group sigue trabajando
	// (issue #9), así que exitCode/signalCode solos NO deben contar como terminado.
	check(
		"cancel-guard: finalized job is finished",
		isFinished({ finalized: true, child: { exitCode: null, signalCode: null } }) === true,
	);
	check(
		"cancel-guard: exited shell with a live group is NOT finished",
		isFinished({ finalized: false, child: { exitCode: 0, signalCode: null } }) === false,
	);
	check(
		"cancel-guard: signalled shell with a live group is NOT finished",
		isFinished({ finalized: false, child: { exitCode: null, signalCode: "SIGTERM" } }) === false,
	);
	check(
		"cancel-guard: live running job is NOT finished",
		isFinished({ finalized: false, child: { exitCode: null, signalCode: null } }) === false,
	);
}

async function main() {
	await runBgScenarios({
		name: "pi-bg-jobs-cancel",
		scenarios: [
			cancelStopsActiveJob,
			cancelEscalatesToSigkill,
			cancelReachesGroupSurvivorsAfterShellExit,
			cancelSignalsVerifiedOrphan,
			cancelVerifiedOrphanKeepsSurvivorNonDeletable,
			cancelRefusesReusedPid,
			jobFinishedGuardRejectsCancel,
		],
	});
}

main().catch((err) => {
	console.error(err?.stack || err);
	process.exit(1);
});
