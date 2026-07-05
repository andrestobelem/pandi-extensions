#!/usr/bin/env node

/**
 * Cobertura de caracterización para ramas de command-dispatch de index.ts que la suite
 * principal bg-jobs no ejerce: la respuesta de error del try/catch top-level, la rama de
 * duplicate-cancel, el rechazo de identidad reused/unknown en cancelPersistedJob, el rechazo
 * non-deletable de handleDelete, los gates untrusted + plan-mode de handlePrune, y
 * reconcileInterruptedJobs omitiendo un job activo en esta sesión.
 *
 * Todas las aserciones pasan por el command handler registrado de `/bg` (que llama a
 * ctx.ui.notify solo con { message, type }; details NO se exponen ahí, así que afirmamos sobre
 * el texto y tipo del message), o por reconcileInterruptedJobs exportado. El código fuente es la
 * fuente de verdad; estos tests registran su comportamiento ACTUAL.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createChecker, loadModule } from "../../../shared/test/harness.mjs";
import {
	buildBg,
	createBgTestDir,
	loadExtension,
	makeCtx,
	makePi,
	parseJobId,
	readJson,
	shellQuote,
	waitFor,
} from "./bg-test-support.mjs";

const { check, counts } = createChecker();

const skipped = [];

// Inicia un child que corre hasta que lo maten; devuelve { jobId, runDir, cleanup }.
async function startLongJob(commands, cwd) {
	const script = path.join(cwd, `long-${Math.random().toString(16).slice(2)}.cjs`);
	const started = path.join(cwd, `started-${Math.random().toString(16).slice(2)}`);
	await fs.writeFile(
		script,
		`const fs = require("node:fs");\n` +
			`fs.writeFileSync(process.argv[2], "started");\n` +
			`setInterval(() => {}, 1000);\n`,
	);
	const ctx = makeCtx({ cwd, trusted: true });
	const command = `${shellQuote(process.execPath)} ${shellQuote(script)} ${shellQuote(started)}`;
	await commands.get("bg").handler(`start ${command}`, ctx);
	const jobId = parseJobId(ctx._notes.at(-1)?.msg || "");
	const runDir = path.join(cwd, ".pi", "bg", "runs", jobId || "missing");
	await waitFor("long job started handshake", async () => existsSync(started));
	await waitFor("long job running status", async () => {
		const s = await readJson(path.join(runDir, "status.json"));
		return s.state === "running" ? s : false;
	});
	const cleanup = async () => {
		await commands.get("bg").handler(`cancel ${jobId}`, ctx);
	};
	return { ctx, jobId, runDir, cleanup };
}

// ── Brecha 1: try/catch top-level de handleBgCommand ─────────────────────────
async function topLevelCatchReturnsErrorResponse(url) {
	const { commands } = await loadExtension(url);
	// Un cwd no string hace que candidateRunRoots(ctx) -> path.join lance sincrónicamente
	// dentro de handleList (un error non-ENOENT), ejerciendo el try/catch de dispatch.
	const ctx = makeCtx({ cwd: 12345, trusted: true });
	let threw = false;
	try {
		await commands.get("bg").handler("list", ctx);
	} catch {
		threw = true;
	}
	const note = ctx._notes.at(-1) || {};
	check("catch: handler does not throw out of the dispatch try/catch", !threw);
	check("catch: surfaces a `/bg failed:` message", /\/bg falló:/.test(note.msg || ""), JSON.stringify(note));
	check("catch: response uses the 'error' type", note.type === "error", JSON.stringify(note));
}

// ── Brecha 2: rama duplicate-request de handleCancel ─────────────────────────
async function duplicateCancelIsReported(url) {
	const { commands } = await loadExtension(url);
	const cwd = await createBgTestDir("pi-bg-dup-cancel-");
	const job = await startLongJob(commands, cwd);
	try {
		await commands.get("bg").handler(`cancel ${job.jobId}`, job.ctx);
		check(
			"dup-cancel: first cancel is accepted",
			/Cancelación solicitada/.test(job.ctx._notes.at(-1)?.msg || ""),
			job.ctx._notes.at(-1)?.msg,
		);
		await commands.get("bg").handler(`cancel ${job.jobId}`, job.ctx);
		const msg = job.ctx._notes.at(-1)?.msg || "";
		check("dup-cancel: second cancel reports already-requested", /Ya se solicitó la cancelación/.test(msg), msg);
		const events = await fs.readFile(path.join(job.runDir, "events.jsonl"), "utf8").catch(() => "");
		const requests = (events.match(/"event":"cancel-requested"/g) || []).length;
		check("dup-cancel: only a single cancel-requested event is recorded", requests === 1, String(requests));
	} finally {
		await waitFor(
			"dup-cancel job terminal",
			async () =>
				["cancelled", "completed", "failed"].includes((await readJson(path.join(job.runDir, "status.json"))).state),
			{ timeoutMs: 8000 },
		).catch(() => {});
	}
}

// ── Brecha 4: rechazo de identidad reused/unknown de cancelPersistedJob ──────
async function cancelPersistedRefusesReusedIdentity(url) {
	const { commands } = await loadExtension(url);
	const cwd = await createBgTestDir("pi-bg-persist-reuse-");
	const jobId = "reused-persisted";
	const runDir = path.join(cwd, ".pi", "bg", "runs", jobId);
	await fs.mkdir(runDir, { recursive: true });
	await fs.writeFile(
		path.join(runDir, "job.json"),
		JSON.stringify({ jobId, command: "x", cwd, createdAt: new Date().toISOString(), artifactsDir: runDir }, null, 2),
	);
	// Pid vivo (este proceso) + identidad registrada stale => verifyProcessIdentity es
	// "different" en POSIX (pid reutilizado) y "unknown" en win32 (no puede verificar).
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
	check("persist-reuse: current process is never signaled", process.kill(process.pid, 0));
	const status = await readJson(path.join(runDir, "status.json"));
	check("persist-reuse: status is left running (not cancelled)", status.state === "running", JSON.stringify(status));
	check("persist-reuse: refuses to cancel", /Rechazando cancelar/.test(msg), msg);
	if (process.platform === "win32") {
		check("persist-reuse: win32 cites unverifiable identity", /no se pudo verificar/.test(msg), msg);
	} else {
		check("persist-reuse: POSIX cites a reused PID", /fue reutilizado/.test(msg), msg);
	}
}

// ── Brecha 5: rechazo non-deletable (live/orphaned) de handleDelete ──────────
async function deleteRefusesLiveOrphan(url) {
	const { commands } = await loadExtension(url);
	const cwd = await createBgTestDir("pi-bg-delete-live-");
	const jobId = "live-orphan";
	const runDir = path.join(cwd, ".pi", "bg", "runs", jobId);
	await fs.mkdir(runDir, { recursive: true });
	await fs.writeFile(
		path.join(runDir, "job.json"),
		JSON.stringify({ jobId, command: "x", cwd, createdAt: new Date().toISOString() }, null, 2),
	);
	// state=running + pid alive (este proceso), sin startId => orphaned, identidad unknown
	// => classifyForDeletion rechaza (no es un estado terminal).
	await fs.writeFile(
		path.join(runDir, "status.json"),
		JSON.stringify({ jobId, state: "running", pid: process.pid, updatedAt: new Date().toISOString() }, null, 2),
	);
	const ctx = makeCtx({ cwd, trusted: true });
	await commands.get("bg").handler(`delete ${jobId}`, ctx);
	const msg = ctx._notes.at(-1)?.msg || "";
	check("delete-live: refuses with `cannot be deleted`", /no se puede eliminar/.test(msg), msg);
	check("delete-live: the run dir is left intact", existsSync(runDir), runDir);
	check("delete-live: current process is still alive (never touched)", process.kill(process.pid, 0));
}

// ── Brecha 6: gates untrusted + plan-mode de handlePrune ─────────────────────
async function pruneUntrustedAndPlanModeRejected(url) {
	const { commands } = await loadExtension(url);

	// Proyecto no confiable: prune se rechaza con un mensaje de trust.
	const untrustedCwd = await createBgTestDir("pi-bg-prune-untrusted-");
	const untrustedCtx = makeCtx({ cwd: untrustedCwd, trusted: false });
	await commands.get("bg").handler("prune", untrustedCtx);
	const untrustedMsg = untrustedCtx._notes.at(-1)?.msg || "";
	check(
		"prune-gate: untrusted project is rejected",
		/No se puede ejecutar \/bg prune en un proyecto no confiable/.test(untrustedMsg),
		untrustedMsg,
	);
	check("prune-gate: untrusted rejection uses 'warning' type", untrustedCtx._notes.at(-1)?.type === "warning");

	// Plan mode activo: prune se rechaza antes del chequeo de trust.
	const planSym = Symbol.for("pandi-plan.plan-mode.guard");
	const prev = globalThis[planSym];
	globalThis[planSym] = { isActive: () => true };
	try {
		const planCwd = await createBgTestDir("pi-bg-prune-plan-");
		const planCtx = makeCtx({ cwd: planCwd, trusted: true });
		await commands.get("bg").handler("prune", planCtx);
		const planMsg = planCtx._notes.at(-1)?.msg || "";
		check(
			"prune-gate: plan mode active is rejected",
			/No se puede ejecutar \/bg prune mientras el modo plan/.test(planMsg),
			planMsg,
		);
		check("prune-gate: plan-mode rejection uses 'warning' type", planCtx._notes.at(-1)?.type === "warning");
	} finally {
		if (prev === undefined) delete globalThis[planSym];
		else globalThis[planSym] = prev;
	}
}

// ── Brecha 7: reconcileInterruptedJobs omite jobs activos en esta sesión ──────
async function reconcileSkipsActiveSessionJob(url) {
	// IMPORTANTE: cargar UNA instancia del módulo para que el command handler y reconcile
	// compartan el mismo registro activeJobs in-process (imports separados con cache-busting
	// tendrían su propio activeJobs y el guard "active" no podría observarse).
	const mod = await loadModule(url);
	const reconcile = mod.reconcileInterruptedJobs;
	const { pi, commands } = makePi();
	mod.default(pi);
	check("reconcile-active: reconcileInterruptedJobs is exported", typeof reconcile === "function", typeof reconcile);
	if (typeof reconcile !== "function") return;

	const cwd = await createBgTestDir("pi-bg-reconcile-active-");
	const job = await startLongJob(commands, cwd);
	try {
		// Manipula el status de este job vivo in-session para que parezca un job running con dead-pid.
		const dead = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
		const statusFile = path.join(job.runDir, "status.json");
		const current = await readJson(statusFile);
		await fs.writeFile(
			statusFile,
			JSON.stringify({ ...current, state: "running", pid: dead.pid, startId: undefined }, null, 2),
		);
		const n = await reconcile(job.ctx);
		check("reconcile-active: reconcile rewrites nothing (active job skipped)", n === 0, String(n));
		const after = await readJson(statusFile);
		check(
			"reconcile-active: the active job's state is NOT rewritten to interrupted",
			after.state === "running",
			JSON.stringify(after),
		);
	} finally {
		await job.cleanup();
		await waitFor(
			"reconcile-active job terminal",
			async () =>
				["cancelled", "completed", "failed"].includes((await readJson(path.join(job.runDir, "status.json"))).state),
			{ timeoutMs: 8000 },
		).catch(() => {});
	}
}

async function main() {
	const { url } = await buildBg();
	await topLevelCatchReturnsErrorResponse(url);
	await duplicateCancelIsReported(url);
	await cancelPersistedRefusesReusedIdentity(url);
	await deleteRefusesLiveOrphan(url);
	await pruneUntrustedAndPlanModeRejected(url);
	await reconcileSkipsActiveSessionJob(url);

	// Intencionalmente no cubierto:
	skipped.push(
		"handleCancel already-finished in-session branch (isJobFinished true while still in activeJobs): the window between child exit (exitCode set) and the 'close' handler running safeFinalize (which deletes the runtime from activeJobs) is not deterministically observable from the command handler, so a non-racy assertion is impossible.",
	);

	console.log(`${counts.passed} passed, ${counts.failed} failed`);
	if (counts.failed > 0) {
		console.log(`Failures:\n${counts.failures.map((f) => `  - ${f}`).join("\n")}`);
		process.exit(1);
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
