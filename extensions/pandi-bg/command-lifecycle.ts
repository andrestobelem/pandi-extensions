/**
 * Handlers de ciclo de vida: preview, start, cancel.
 */

import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type BgResponse, canRunInMode, rejectInPlanMode, response } from "./command-shared.js";
import { findJobDir } from "./job-listing.js";
import {
	guardStreamErrors,
	isJobFinished,
	killRuntime,
	pipeWithBackpressure,
	safeFinalize,
	signalProcessGroup,
	writeStatus,
} from "./job-runtime.js";
import { probeProcessAlive, readProcessStartId, verifyProcessIdentity } from "./process-liveness.js";
import { activeJobs, appendEvent, asNumber, asString, nowIso } from "./runtime-state.js";
import { atomicWriteJson, createRunDir, generateJobId, readJson, validJobId } from "./storage.js";
import type { JobStatus, RuntimeJob } from "./types.js";

const CANCEL_GRACE_MS = 750;
const RECONCILABLE_STATES = new Set(["starting", "running"]);

export async function handlePreview(command: string): Promise<BgResponse> {
	if (!command.trim()) return response("Uso: /bg preview <command>", undefined, "warning");
	return response(
		[
			"Solo dry run — no se inició ningún job en segundo plano.",
			"",
			"Comando a ejecutar:",
			command.trim(),
			"",
			"Usá /bg start <command> en una sesión TUI/RPC confiable para ejecutarlo.",
		].join("\n"),
		{ action: "preview", command: command.trim(), dryRun: true },
	);
}

export async function handleStart(ctx: ExtensionContext, command: string): Promise<BgResponse> {
	const blocked = rejectInPlanMode("start");
	if (blocked) return blocked;
	const trimmed = command.trim();
	if (!trimmed) return response("Uso: /bg start <command>", undefined, "warning");
	if (!canRunInMode(ctx))
		return response(
			"No se puede ejecutar /bg start fuera de una sesión TUI/RPC persistente.",
			{ action: "start", blockedBy: "mode", mode: ctx.mode },
			"warning",
		);
	if (!ctx.isProjectTrusted())
		return response(
			"No se puede ejecutar /bg start en un proyecto no confiable.",
			{ action: "start", blockedBy: "trust" },
			"warning",
		);

	const jobId = generateJobId();
	const runDir = await createRunDir(ctx, jobId);
	const createdAt = nowIso();
	const job = {
		jobId,
		command: trimmed,
		cwd: ctx.cwd,
		createdAt,
		runner: "node-child-process",
		source: "slash",
		artifactsDir: runDir,
	};
	const initialStatus: JobStatus = {
		jobId,
		state: "starting",
		updatedAt: createdAt,
		startedAt: createdAt,
		cancelRequested: false,
	};
	await atomicWriteJson(path.join(runDir, "job.json"), job);
	await atomicWriteJson(path.join(runDir, "status.json"), initialStatus);
	await appendEvent(runDir, { event: "start", jobId, command: trimmed, cwd: ctx.cwd });

	const stdoutStream = createWriteStream(path.join(runDir, "stdout.log"), { flags: "a" });
	const stderrStream = createWriteStream(path.join(runDir, "stderr.log"), { flags: "a" });
	const combinedStream = createWriteStream(path.join(runDir, "combined.log"), { flags: "a" });
	const child = spawn(trimmed, {
		cwd: ctx.cwd,
		shell: true,
		detached: process.platform !== "win32",
		stdio: ["ignore", "pipe", "pipe"],
	});
	guardStreamErrors(runDir, jobId, [stdoutStream, stderrStream, combinedStream, child.stdout, child.stderr]);

	const runtime: RuntimeJob = {
		jobId,
		runDir,
		command: trimmed,
		child,
		status: initialStatus,
		stdoutStream,
		stderrStream,
		combinedStream,
		finalized: false,
	};
	activeJobs.set(jobId, runtime);

	pipeWithBackpressure(child.stdout, [stdoutStream, combinedStream]);
	pipeWithBackpressure(child.stderr, [stderrStream, combinedStream]);
	child.on("error", (err) => {
		safeFinalize(runtime, null, null, err);
	});
	child.on("close", (code, signal) => {
		safeFinalize(runtime, code, signal);
	});

	const startId = readProcessStartId(child.pid);
	await writeStatus(runtime, { state: "running", pid: child.pid, ...(startId ? { startId } : {}) });
	await appendEvent(runDir, { event: "running", jobId, pid: child.pid });

	return response(
		[
			`Job en segundo plano ${jobId} iniciado.`,
			`Artifacts: ${runDir}`,
			`Estado: /bg status ${jobId}`,
			`Logs: /bg logs ${jobId}`,
		].join("\n"),
		{ action: "start", jobId, artifactsDir: runDir, pid: child.pid },
	);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function cancelPersistedJob(ctx: ExtensionContext, jobId: string): Promise<BgResponse> {
	const runDir = await findJobDir(ctx, jobId);
	if (!runDir)
		return response(
			`El job en segundo plano ${jobId} no está activo en esta sesión; no se mató ningún proceso.`,
			{ action: "cancel", jobId, active: false },
			"warning",
		);
	const status = (await readJson(path.join(runDir, "status.json"))) ?? {};
	const state = asString(status.state);
	if (!state || !RECONCILABLE_STATES.has(state)) {
		return response(
			`El job en segundo plano ${jobId} ya terminó (${state ?? "unknown"}); no hay nada que cancelar.`,
			{ action: "cancel", jobId, active: false, alreadyFinished: true },
			"warning",
		);
	}
	const pid = asNumber(status.pid);
	const identity = verifyProcessIdentity(pid, asString(status.startId));
	if (identity !== "same") {
		const why =
			identity === "different"
				? `su PID ${pid} fue reutilizado por otro proceso`
				: "no se pudo verificar la identidad de su proceso";
		return response(
			`Rechazando cancelar el job en segundo plano ${jobId}: ${why}, así que no es seguro enviarle una señal. Fue iniciado por otra sesión de Pi; usá herramientas del SO (kill -- -${pid} / taskkill) si sigue corriendo.`,
			{ action: "cancel", jobId, active: false, signaled: false, identity },
			"warning",
		);
	}
	await appendEvent(runDir, { event: "cancel-verified-orphan", jobId, pid });
	let signaled = false;
	try {
		signalProcessGroup(pid!, "SIGTERM");
		signaled = true;
	} catch (err) {
		await appendEvent(runDir, {
			event: "cancel-orphan-error",
			jobId,
			error: (err as Error).message,
		});
	}
	let escalated = false;
	if (signaled) {
		await sleep(CANCEL_GRACE_MS);
		if (verifyProcessIdentity(pid, asString(status.startId)) === "same") {
			try {
				signalProcessGroup(pid!, "SIGKILL");
				escalated = true;
				await appendEvent(runDir, { event: "cancel-orphan-sigkill", jobId, pid });
			} catch (err) {
				await appendEvent(runDir, {
					event: "cancel-orphan-sigkill-error",
					jobId,
					error: (err as Error).message,
				});
			}
			await sleep(CANCEL_GRACE_MS);
		}
	}
	const identityAfterCancel = verifyProcessIdentity(pid, asString(status.startId));
	const processTerminated = identityAfterCancel === "different" || probeProcessAlive(pid) === "dead";
	if (!processTerminated) {
		await appendEvent(runDir, { event: "cancel-orphan-survived", jobId, pid });
		await atomicWriteJson(path.join(runDir, "status.json"), {
			...status,
			state: "orphaned",
			cancelRequested: true,
			updatedAt: nowIso(),
			reason: "cancel-signal-sent-process-still-alive",
		});
		return response(
			`Se envió ${escalated ? "SIGTERM y SIGKILL" : "SIGTERM"} al huérfano verificado ${jobId} (pid ${pid}), pero el proceso sigue vivo; no se lo marcó como cancelado/deletable.`,
			{ action: "cancel", jobId, active: false, signaled, escalated, stillAlive: true, identity: "verified" },
			"warning",
		);
	}
	const now = nowIso();
	await atomicWriteJson(path.join(runDir, "status.json"), {
		...status,
		state: "cancelled",
		cancelRequested: true,
		completedAt: now,
		updatedAt: now,
		reason: "cancel-verified-orphan",
	});
	return response(
		signaled
			? `Se envió ${escalated ? "SIGTERM y SIGKILL" : "SIGTERM"} al huérfano verificado ${jobId} (pid ${pid}) y se lo marcó como cancelado.`
			: `Se marcó el huérfano verificado ${jobId} como cancelado, pero falló el envío de señal al pid ${pid}.`,
		{ action: "cancel", jobId, active: false, signaled, escalated, identity: identityAfterCancel },
	);
}

export async function handleCancel(ctx: ExtensionContext, jobId: string): Promise<BgResponse> {
	const blocked = rejectInPlanMode("cancel");
	if (blocked) return blocked;
	const trimmed = jobId.trim();
	if (!trimmed || !validJobId(trimmed)) return response("Uso: /bg cancel <jobId>", undefined, "warning");
	const runtime = activeJobs.get(trimmed);
	if (!runtime) return await cancelPersistedJob(ctx, trimmed);
	if (isJobFinished(runtime)) {
		return response(
			`El job en segundo plano ${trimmed} ya terminó; no hay nada que cancelar.`,
			{ action: "cancel", jobId: trimmed, active: false, alreadyFinished: true },
			"warning",
		);
	}
	if (runtime.status.cancelRequested) {
		return response(
			`Ya se solicitó la cancelación del job en segundo plano ${trimmed}.`,
			{ action: "cancel", jobId: trimmed, active: true, duplicate: true },
			"warning",
		);
	}

	await writeStatus(runtime, { cancelRequested: true });
	await appendEvent(runtime.runDir, {
		event: "cancel-requested",
		jobId: trimmed,
		pid: runtime.child.pid,
	});
	try {
		killRuntime(runtime, "SIGTERM");
	} catch (err) {
		await appendEvent(runtime.runDir, {
			event: "cancel-sigterm-error",
			jobId: trimmed,
			error: (err as Error).message,
		});
	}
	runtime.cancelTimer = setTimeout(() => {
		if (runtime.finalized) return;
		try {
			killRuntime(runtime, "SIGKILL");
			void appendEvent(runtime.runDir, {
				event: "cancel-sigkill",
				jobId: trimmed,
				pid: runtime.child.pid,
			});
		} catch (err) {
			void appendEvent(runtime.runDir, {
				event: "cancel-sigkill-error",
				jobId: trimmed,
				error: (err as Error).message,
			});
		}
	}, CANCEL_GRACE_MS);
	return response(`Cancelación solicitada para el job en segundo plano ${trimmed}.`, {
		action: "cancel",
		jobId: trimmed,
		active: true,
	});
}
