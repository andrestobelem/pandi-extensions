/**
 * Jobs en segundo plano locales de `/bg` (M2a).
 *
 * El alcance es deliberadamente estrecho: solo slash commands humanas, runner local
 * con child_process, inicios solo en proyectos confiables, sin runner de Supacode y
 * sin tool LLM mutante.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	guardStreamErrors,
	isJobFinished,
	killRuntime,
	pipeWithBackpressure,
	safeFinalize,
	signalProcessGroup,
	writeStatus,
} from "./job-runtime.js";
import { decorateStatus, deriveState, projectState, refineOrphanedIdentity } from "./job-state.js";
import { probeProcessAlive, readProcessStartId, verifyProcessIdentity } from "./process-liveness.js";
import { activeJobs, appendEvent, asNumber, asString, nowIso } from "./runtime-state.js";
import {
	atomicWriteJson,
	candidateRunRoots,
	createRunDir,
	dirSizeBytes,
	generateJobId,
	getProjectBgRoot,
	lstatPlainDirectory,
	lstatPlainDirectoryChain,
	parsePruneFlags,
	RUNS_DIR,
	readJson,
	removeRunDir,
	validJobId,
} from "./storage.js";

// El ciclo de vida de child-process + log-stream vive en ./job-runtime.ts; se reexportan
// porque la suite de integración los importa desde el bundle generado.
export {
	finalizeJob,
	guardStreamErrors,
	isJobFinished,
	pipeWithBackpressure,
	safeFinalize,
	writeStatus,
} from "./job-runtime.js";
export { probeProcessAlive, readProcessStartId, verifyProcessIdentity } from "./process-liveness.js";
export { atomicWriteJson, dirSizeBytes, parsePruneFlags, removeRunDir };

const MAX_LOG_BYTES = 20_000;
const CANCEL_GRACE_MS = 750;
const PLAN_MODE_GUARD_SYMBOL = Symbol.for("pandi-plan.plan-mode.guard");

export type JobState =
	| "starting"
	| "running"
	| "completed"
	| "failed"
	| "cancelled"
	| "orphaned"
	| "interrupted"
	| "stale"
	| "unknown";

interface PlanModeGuard {
	isActive(): boolean;
}

interface JobSummary {
	jobId: string;
	command?: string;
	state?: JobState;
	createdAt?: string;
	updatedAt?: string;
	artifactsDir: string;
}

export interface JobStatus {
	jobId: string;
	state: JobState;
	pid?: number;
	startId?: string;
	startedAt?: string;
	updatedAt: string;
	completedAt?: string;
	exitCode?: number | null;
	signal?: string | null;
	cancelRequested?: boolean;
	active?: boolean;
	persistedState?: string;
	error?: string;
}

export interface RuntimeJob {
	jobId: string;
	runDir: string;
	command: string;
	child: ChildProcess;
	status: JobStatus;
	stdoutStream: WriteStream;
	stderrStream: WriteStream;
	combinedStream: WriteStream;
	cancelTimer?: ReturnType<typeof setTimeout>;
	statusWriteChain?: Promise<void>;
	finalized: boolean;
}

interface BgResponse {
	message: string;
	details?: unknown;
	type?: "info" | "warning" | "error";
}

// La proyección read-time de job-state (projectState/deriveState/refineOrphanedIdentity/
// decorateStatus) vive en ./job-state.ts; se importa acá y se usa en listados,
// status y rutas de eliminación. Interno (no es parte de la superficie pública).

async function listJobs(ctx: ExtensionContext): Promise<JobSummary[]> {
	const jobs: JobSummary[] = [];
	for (const { root, baseDir } of candidateRunRoots(ctx)) {
		if (!(await lstatPlainDirectoryChain(baseDir, root))) continue;
		let entries: { name: string; isDirectory(): boolean }[];
		try {
			entries = await fs.readdir(root, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (!entry.isDirectory() || !validJobId(entry.name)) continue;
			const runDir = path.join(root, entry.name);
			if (!(await lstatPlainDirectory(runDir))) continue;
			const job = await readJson(path.join(runDir, "job.json"));
			const status = await readJson(path.join(runDir, "status.json"));
			jobs.push({
				jobId: entry.name,
				command: asString(job?.command),
				state: deriveState(entry.name, status),
				createdAt: asString(job?.createdAt),
				updatedAt: asString(status?.updatedAt),
				artifactsDir: runDir,
			});
		}
	}
	return jobs.sort((a, b) => (b.updatedAt ?? b.createdAt ?? "").localeCompare(a.updatedAt ?? a.createdAt ?? ""));
}

async function findJobDir(ctx: ExtensionContext, jobId: string): Promise<string | undefined> {
	if (!validJobId(jobId)) return undefined;
	for (const { root, baseDir } of candidateRunRoots(ctx)) {
		if (!(await lstatPlainDirectoryChain(baseDir, root))) continue;
		const runDir = path.join(root, jobId);
		if (await lstatPlainDirectory(runDir)) return runDir;
	}
	return undefined;
}

const RECONCILABLE_STATES = new Set(["starting", "running"]);
// Únicos estados en los que pueden eliminarse los artefactos de un job terminado.
// `starting`/`running` (y read-time `orphaned`/`stale`/`unknown`) nunca son eliminables;
// ver classifyForDeletion.
const DELETABLE_STATES = new Set(["completed", "failed", "cancelled", "interrupted"]);

// Enumera run dirs locales del proyecto (solo confiables), devolviendo {jobId, runDir, status}
// por cada job dir válido y sin symlink. Compartido por reconcile y prune para que los gates
// de trust/symlink/path y el salto del dotfile .audit.jsonl (validJobId rechaza el punto
// inicial) vivan en un solo lugar. El filtrado de sesión activa y la lógica de estado quedan
// en quien llama.
async function eachProjectRunDir(
	ctx: ExtensionContext,
): Promise<{ jobId: string; runDir: string; status: Record<string, unknown> | undefined }[]> {
	if (!ctx.isProjectTrusted()) return [];
	const root = path.join(getProjectBgRoot(ctx), RUNS_DIR);
	if (!(await lstatPlainDirectoryChain(ctx.cwd, root))) return [];
	let entries: { name: string; isDirectory(): boolean }[];
	try {
		entries = await fs.readdir(root, { withFileTypes: true });
	} catch {
		return [];
	}
	const out: { jobId: string; runDir: string; status: Record<string, unknown> | undefined }[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory() || !validJobId(entry.name)) continue;
		const runDir = path.join(root, entry.name);
		if (!(await lstatPlainDirectory(runDir))) continue;
		out.push({
			jobId: entry.name,
			runDir,
			status: await readJson(path.join(runDir, "status.json")),
		});
	}
	return out;
}

// Self-heal al session-start: un proceso Pi nuevo no posee jobs (activeJobs está vacío),
// así que todo job local del proyecto persistido como starting/running viene de una corrida
// anterior. Se prueba su pid registrado; un pid DEAD significa que el proceso ya no existe
// (Pi murió antes de finalize), así que el artefacto se reescribe atómicamente a un estado
// terminal `interrupted`. Los jobs vivos/no comprobables quedan intactos (la proyección
// read-time aún muestra orphaned/stale). Escribir `interrupted` solo con un pid confirmado
// muerto evita el riesgo de reutilización de pid: un pid muerto nunca puede ser nuestro job
// vivo, así que el estado terminal siempre es correcto. Solo project root (la única root que
// escribe pandi-bg, y solo cuando es confiable); mejor esfuerzo, nunca lanza hacia
// session_start.
export async function reconcileInterruptedJobs(ctx: ExtensionContext): Promise<number> {
	let reconciled = 0;
	for (const { jobId, runDir, status } of await eachProjectRunDir(ctx)) {
		if (activeJobs.has(jobId)) continue;
		const state = asString(status?.state);
		if (!state || !RECONCILABLE_STATES.has(state)) continue;
		const pid = asNumber(status?.pid);
		const live = probeProcessAlive(pid);
		// Dead pid => proceso ausente. Alive pero con identidad de inicio distinta => el pid
		// fue reutilizado, así que nuestro proceso también terminó. Ambos son evidencia positiva
		// para terminalizar; un pid alive que no podemos descartar (same/unknown) queda como
		// orphaned/stale read-time.
		const cause =
			live === "dead"
				? "pid-dead"
				: live === "alive" && verifyProcessIdentity(pid, asString(status?.startId)) === "different"
					? "pid-reused"
					: undefined;
		if (!cause) continue;
		const now = nowIso();
		try {
			await atomicWriteJson(path.join(runDir, "status.json"), {
				...status,
				state: "interrupted",
				completedAt: now,
				updatedAt: now,
				reason: "session-start-reconcile",
			});
			await appendEvent(runDir, {
				event: "reconcile-interrupted",
				jobId,
				pid: pid ?? null,
				persistedState: state,
				cause,
			});
			reconciled++;
		} catch {
			// Mejor esfuerzo: deja el artefacto intacto si falla la reescritura atómica.
		}
	}
	return reconciled;
}

function formatJob(job: JobSummary): string {
	const command = job.command ? ` — ${job.command}` : "";
	const when = job.updatedAt ?? job.createdAt;
	return `- ${job.jobId}: ${job.state ?? "unknown"}${when ? ` (${when})` : ""}${command}`;
}

function response(message: string, details?: unknown, type: BgResponse["type"] = "info"): BgResponse {
	return { message, details, type };
}

function notify(ctx: ExtensionContext, result: BgResponse): void {
	const type = result.type ?? "info";
	if (ctx.mode === "print") {
		(type === "info" ? console.log : console.error)(result.message);
		return;
	}
	if (ctx.hasUI) {
		ctx.ui.notify(result.message, type);
		return;
	}
	if (type !== "info") console.error(result.message);
}

function planModeActive(): boolean {
	const guard = (globalThis as Record<symbol, PlanModeGuard | undefined>)[PLAN_MODE_GUARD_SYMBOL];
	try {
		return guard?.isActive() === true;
	} catch {
		return false;
	}
}

function rejectInPlanMode(action: "start" | "cancel" | "delete" | "prune"): BgResponse | undefined {
	if (!planModeActive()) return undefined;
	return response(
		`No se puede ejecutar /bg ${action} mientras el modo plan está activo. Aprobá o salí de /plan primero.`,
		{ action, blockedBy: "plan-mode" },
		"warning",
	);
}

function canRunInMode(ctx: ExtensionContext): boolean {
	return ctx.mode === "tui" || ctx.mode === "rpc";
}

// La escritura del sidecar de status, backpressure/guarding de streams, finalize one-shot y
// señales al process group viven en ./job-runtime.ts (importado arriba + reexportado para tests).

async function handlePreview(command: string): Promise<BgResponse> {
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

async function handleStart(ctx: ExtensionContext, command: string): Promise<BgResponse> {
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
			`Artefactos: ${runDir}`,
			`Estado: /bg status ${jobId}`,
			`Logs: /bg logs ${jobId}`,
		].join("\n"),
		{ action: "start", jobId, artifactsDir: runDir, pid: child.pid },
	);
}

// Cancela un job que esta sesión no posee (persistido por otro proceso/corrida de Pi).
// La regla de seguridad que la ruta in-session da por sentada debe ganarse acá: solo enviar
// señal cuando el pid vivo está VERIFIED como nuestro proceso (misma identidad de inicio).
// Un pid reutilizado o no verificable nunca recibe señal; queda para herramientas del SO.
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
	const now = nowIso();
	if (signaled) {
		await sleep(CANCEL_GRACE_MS);
		if (verifyProcessIdentity(pid, asString(status.startId)) === "same") {
			await appendEvent(runDir, { event: "cancel-orphan-survived", jobId, pid });
			await atomicWriteJson(path.join(runDir, "status.json"), {
				...status,
				state: "orphaned",
				cancelRequested: true,
				updatedAt: now,
				reason: "cancel-signal-sent-process-still-alive",
			});
			return response(
				`Se envió SIGTERM al huérfano verificado ${jobId} (pid ${pid}), pero el proceso sigue vivo; no se lo marcó como cancelado/deletable.`,
				{ action: "cancel", jobId, active: false, signaled, stillAlive: true, identity: "verified" },
				"warning",
			);
		}
	}
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
			? `Se envió SIGTERM al huérfano verificado ${jobId} (pid ${pid}) y se lo marcó como cancelado.`
			: `Se marcó el huérfano verificado ${jobId} como cancelado, pero falló el envío de señal al pid ${pid}.`,
		{ action: "cancel", jobId, active: false, signaled, identity: "verified" },
	);
}

async function handleCancel(ctx: ExtensionContext, jobId: string): Promise<BgResponse> {
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

async function handleList(ctx: ExtensionContext): Promise<BgResponse> {
	const jobs = await listJobs(ctx);
	if (jobs.length === 0) return response("No se encontraron jobs en segundo plano.", { jobs: [] });
	return response(["Jobs en segundo plano:", ...jobs.map(formatJob)].join("\n"), { jobs });
}

// Fuente única de verdad para decidir si pueden eliminarse los artefactos de un job. Nunca
// confía en status.json.state como liveness: rederiva el estado vivo vía projectState y refina
// un pid huérfano por identidad. Los jobs activos (poseídos), verificados o vivos no verificables
// nunca son eliminables; un pid reutilizado refina a `interrupted` y sí lo es.
function classifyForDeletion(
	jobId: string,
	status: Record<string, unknown> | undefined,
): { liveState: string; deletable: boolean; reason?: string } {
	if (activeJobs.has(jobId)) return { liveState: "running", deletable: false, reason: "está activo en esta sesión" };
	const pid = asNumber(status?.pid);
	let state: string = projectState(jobId, asString(status?.state), pid).state;
	if (state === "orphaned") state = refineOrphanedIdentity(pid, asString(status?.startId)).state;
	if (DELETABLE_STATES.has(state)) return { liveState: state, deletable: true };
	const reason =
		state === "orphaned"
			? "su proceso sigue vivo (o no se puede verificar su identidad)"
			: state === "stale"
				? "no se puede comprobar si sigue vivo"
				: `no está en un estado terminal (${state})`;
	return { liveState: state, deletable: false, reason };
}

// Elimina jobs terminados en lote. R4 implementa la vista previa dry-run por defecto: lista
// candidatos eliminables (con tamaño) y jobs omitidos con motivos, sin eliminar nada. R5
// cablea la ejecución con --yes. classifyForDeletion es el único predicado de eliminabilidad.
async function handlePrune(ctx: ExtensionContext, tail: string): Promise<BgResponse> {
	const blocked = rejectInPlanMode("prune");
	if (blocked) return blocked;
	if (!ctx.isProjectTrusted())
		return response(
			"No se puede ejecutar /bg prune en un proyecto no confiable.",
			{ action: "prune", blockedBy: "trust" },
			"warning",
		);
	const { yes } = parsePruneFlags(tail);
	const candidates: { jobId: string; state: string; bytes: number }[] = [];
	const skipped: { jobId: string; state: string; reason: string }[] = [];
	for (const { jobId, runDir, status } of await eachProjectRunDir(ctx)) {
		const verdict = classifyForDeletion(jobId, status);
		if (verdict.deletable) candidates.push({ jobId, state: verdict.liveState, bytes: await dirSizeBytes(runDir) });
		else skipped.push({ jobId, state: verdict.liveState, reason: verdict.reason ?? "no se puede eliminar" });
	}
	const totalBytes = candidates.reduce((sum, c) => sum + c.bytes, 0);
	if (yes) {
		// Elimina cada candidato vía el removeRunDir compartido, que rederiva eliminabilidad
		// desde una lectura fresca de status justo antes de fs.rm (para omitir un job revivido
		// desde el escaneo) y agrega una línea .audit.jsonl por eliminación.
		const deleted: string[] = [];
		for (const c of candidates) {
			if (
				await removeRunDir(
					ctx,
					c.jobId,
					{ verb: "prune", state: c.state, sizeBytes: c.bytes },
					(reread) => classifyForDeletion(c.jobId, reread).deletable,
				)
			)
				deleted.push(c.jobId);
		}
		const execLines = [
			`Se eliminaron ${deleted.length} de ${candidates.length} job(s) candidato(s) (${skipped.length} omitido(s)).`,
			...deleted.map((id) => `  eliminado ${id}`),
		];
		return response(execLines.join("\n"), {
			action: "prune",
			dryRun: false,
			deleted,
			skipped,
			totalBytes,
		});
	}
	const lines = [
		`Vista previa de prune: ${candidates.length} eliminable(s) (${totalBytes} bytes), ${skipped.length} omitido(s).`,
		...candidates.map((c) => `  eliminar ${c.jobId} · ${c.state} · ${c.bytes}B`),
		...skipped.map((s) => `  omitir  ${s.jobId} · ${s.state} · ${s.reason}`),
		candidates.length ? `Ejecutá /bg prune --yes para eliminar ${candidates.length} job(s).` : "Nada para eliminar.",
	];
	return response(lines.join("\n"), {
		action: "prune",
		dryRun: true,
		candidates,
		skipped,
		totalBytes,
	});
}

// Elimina artefactos de un job terminado, gateado por estado LIVE rederivado
// (classifyForDeletion) para que un job running/active/verified-alive nunca sea eliminable.
// removeRunDir aplica scope de proyecto + seguridad de symlink en el borde.
async function handleDelete(ctx: ExtensionContext, jobId: string): Promise<BgResponse> {
	const blocked = rejectInPlanMode("delete");
	if (blocked) return blocked;
	if (!ctx.isProjectTrusted())
		return response(
			"No se puede ejecutar /bg delete en un proyecto no confiable.",
			{ action: "delete", blockedBy: "trust" },
			"warning",
		);
	const runDir = await resolveRunDir(ctx, jobId, "Uso: /bg delete <jobId>");
	if (typeof runDir !== "string") return runDir;
	// Límite de escritura: solo el store local del proyecto es mutable. Un job global-fallback
	// resuelve vía findJobDir para lecturas, pero delete lo rechaza (read-only).
	const projectRuns = path.join(getProjectBgRoot(ctx), RUNS_DIR);
	if (!path.resolve(runDir).startsWith(path.resolve(projectRuns) + path.sep)) {
		return response(
			`El job en segundo plano ${jobId} vive en el almacén global de respaldo (solo lectura); /bg delete solo elimina jobs locales del proyecto.`,
			{ action: "delete", jobId, deleted: false, scope: "global" },
			"warning",
		);
	}
	const status = (await readJson(path.join(runDir, "status.json"))) ?? {};
	const verdict = classifyForDeletion(jobId, status);
	if (!verdict.deletable) {
		return response(
			`El job en segundo plano ${jobId} no se puede eliminar: ${verdict.reason}.`,
			{ action: "delete", jobId, deleted: false, liveState: verdict.liveState },
			"warning",
		);
	}
	// Rederiva eliminabilidad desde una lectura fresca de status justo antes de fs.rm (guard TOCTOU).
	const removed = await removeRunDir(
		ctx,
		jobId,
		{ verb: "delete", state: verdict.liveState },
		(reread) => classifyForDeletion(jobId, reread).deletable,
	);
	if (!removed)
		return response(
			`Job en segundo plano no encontrado: ${jobId}`,
			{ action: "delete", jobId, deleted: false },
			"warning",
		);
	return response(`Job en segundo plano ${jobId} eliminado.`, { action: "delete", jobId, deleted: true });
}

// Valida un job id y resuelve su run directory symlink-safe, o devuelve el warning compartido
// de uso/no encontrado para que todo subcomando de lectura se comporte igual.
async function resolveRunDir(ctx: ExtensionContext, jobId: string, usage: string): Promise<string | BgResponse> {
	if (!jobId || !validJobId(jobId)) return response(usage, undefined, "warning");
	const runDir = await findJobDir(ctx, jobId);
	if (!runDir) return response(`Job en segundo plano no encontrado: ${jobId}`, { jobId, found: false }, "warning");
	return runDir;
}

async function handleStatus(ctx: ExtensionContext, jobId: string): Promise<BgResponse> {
	const runDir = await resolveRunDir(ctx, jobId, "Uso: /bg status <jobId>");
	if (typeof runDir !== "string") return runDir;
	const job = (await readJson(path.join(runDir, "job.json"))) ?? {};
	const rawStatus = (await readJson(path.join(runDir, "status.json"))) ?? {};
	const status = decorateStatus(jobId, rawStatus);
	// Refina un `orphaned` de mejor esfuerzo con una sola prueba de identidad (un job => un ps
	// en macOS/BSD; /bg list deliberadamente NO hace esto para evitar N subprocesses): un pid
	// reutilizado baja a `interrupted`; un pid verificado se marca para que el operador confíe.
	if (status.state === "orphaned") {
		const pid = asNumber(status.pid);
		const refined = refineOrphanedIdentity(pid, asString(status.startId));
		if (refined.state === "interrupted") {
			status.state = "interrupted";
			delete status.hint;
			status.interruptedCause = "pid-reused";
		} else if (refined.verified) {
			status.identity = "verified";
			status.hint = `El PID ${pid} está verificado y sigue corriendo (misma identidad de inicio). Detenélo con kill -- -${pid} / taskkill; /bg cancel no le va a enviar una señal a un PID persistido.`;
		}
	}
	return response(JSON.stringify({ jobId, artifactsDir: runDir, job, status }, null, 2), {
		jobId,
		artifactsDir: runDir,
		job,
		status,
	});
}

async function isReadableLogFile(file: string): Promise<boolean> {
	try {
		return (await fs.lstat(file)).isFile();
	} catch {
		return false;
	}
}

async function readBoundedLog(file: string): Promise<string | undefined> {
	let handle: fs.FileHandle | undefined;
	try {
		if (!(await isReadableLogFile(file))) return undefined;
		handle = await fs.open(file, "r");
		const stat = await handle.stat();
		const bytesToRead = Math.min(stat.size, MAX_LOG_BYTES);
		const buffer = Buffer.alloc(bytesToRead);
		await handle.read(buffer, 0, bytesToRead, Math.max(0, stat.size - bytesToRead));
		const truncated = stat.size > MAX_LOG_BYTES;
		// Un tail acotado por bytes puede empezar en medio de una secuencia UTF-8; descarta bytes
		// de continuación iniciales (0b10xxxxxx) para que el primer carácter decodifique limpio
		// en vez de U+FFFD.
		let start = 0;
		if (truncated) {
			while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start++;
		}
		const data = buffer.subarray(start).toString("utf8");
		if (!truncated) return data;
		return `[truncado a los últimos ${MAX_LOG_BYTES} bytes]\n${data}`;
	} catch {
		return undefined;
	} finally {
		await handle?.close().catch(() => undefined);
	}
}

// Lee un tail acotado y symlink-safe de un artefacto con forma de respuesta /bg, o undefined
// cuando el artefacto no existe para que quienes llaman puedan recurrir a otra fuente.
async function boundedArtifactResponse(
	runDir: string,
	jobId: string,
	file: string,
	source: string,
	emptyText: string,
): Promise<BgResponse | undefined> {
	const text = await readBoundedLog(path.join(runDir, file));
	if (text === undefined) return undefined;
	return response(text || emptyText, { jobId, source, truncatedTo: MAX_LOG_BYTES });
}

async function handleLogs(ctx: ExtensionContext, jobId: string): Promise<BgResponse> {
	const runDir = await resolveRunDir(ctx, jobId, "Uso: /bg logs <jobId>");
	if (typeof runDir !== "string") return runDir;
	const combined = await boundedArtifactResponse(runDir, jobId, "combined.log", "combined.log", "(empty log)");
	if (combined) return combined;
	const stdout = await readBoundedLog(path.join(runDir, "stdout.log"));
	const stderr = await readBoundedLog(path.join(runDir, "stderr.log"));
	if (stdout === undefined && stderr === undefined)
		return response(`No se encontraron logs para ${jobId}.`, { jobId, found: true, logs: false }, "warning");
	return response(
		[
			stdout !== undefined ? `== stdout ==\n${stdout}` : undefined,
			stderr !== undefined ? `== stderr ==\n${stderr}` : undefined,
		]
			.filter(Boolean)
			.join("\n"),
		{
			jobId,
			source: "stdout/stderr",
			truncatedTo: MAX_LOG_BYTES,
		},
	);
}

// Expone el journal estructurado del ciclo de vida (start/running/cancel-*/finish/
// reconcile-interrupted/finalize-error). Explica POR QUÉ un job terminó
// failed/cancelled/interrupted: evidencia que status.json solo no contiene.
// Acotado/symlink-safe vía la misma ruta readBoundedLog que /bg logs.
async function handleEvents(ctx: ExtensionContext, jobId: string): Promise<BgResponse> {
	const runDir = await resolveRunDir(ctx, jobId, "Uso: /bg events <jobId>");
	if (typeof runDir !== "string") return runDir;
	const events = await boundedArtifactResponse(runDir, jobId, "events.jsonl", "events.jsonl", "(no events)");
	if (events) return events;
	return response(`No se encontraron eventos para ${jobId}.`, { jobId, found: true, events: false }, "warning");
}

async function handleBgCommand(args: string, ctx: ExtensionContext): Promise<BgResponse> {
	try {
		const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(args.trimStart());
		if (!match) {
			return response(
				"Uso: /bg preview <command> | /bg start <command> | /bg cancel <jobId> | /bg list | /bg status <jobId> | /bg logs <jobId> | /bg events <jobId> | /bg delete <jobId> | /bg prune [--yes]",
				undefined,
				"warning",
			);
		}
		const subcommand = match[1] ?? "";
		const tail = match[2] ?? "";
		switch (subcommand.toLowerCase()) {
			case "preview":
			case "plan": // alias deprecated de preview
				return await handlePreview(tail);
			case "start":
				return await handleStart(ctx, tail);
			case "cancel":
				return await handleCancel(ctx, tail.trim());
			case "list":
				return await handleList(ctx);
			case "status":
				return await handleStatus(ctx, tail.trim());
			case "logs":
				return await handleLogs(ctx, tail.trim());
			case "events":
				return await handleEvents(ctx, tail.trim());
			case "delete":
				return await handleDelete(ctx, tail.trim());
			case "prune":
				return await handlePrune(ctx, tail);
			default:
				return response(
					`Subcomando /bg desconocido: ${subcommand}. Soportados: preview, start, cancel, list, status, logs, events, delete, prune.`,
					undefined,
					"warning",
				);
		}
	} catch (err) {
		return response(`/bg falló: ${(err as Error).message}`, { error: (err as Error).message }, "error");
	}
}

export default function bgExtension(pi: ExtensionAPI): void {
	pi.registerCommand("bg", {
		description:
			"Jobs en segundo plano: /bg preview <command> | /bg start <command> | /bg cancel <jobId> | /bg list | /bg status <jobId> | /bg logs <jobId> | /bg events <jobId> | /bg delete <jobId> | /bg prune [--yes]",
		getArgumentCompletions: (argumentPrefix: string) => {
			const items = [
				{
					value: "preview",
					label: "preview",
					description: "Dry-run (vista previa) de un comando en segundo plano",
				},
				{ value: "start", label: "start", description: "Iniciar un job en segundo plano" },
				{ value: "cancel", label: "cancel", description: "Cancelar un job activo en segundo plano" },
				{ value: "list", label: "list", description: "Listar artefactos de jobs en segundo plano" },
				{ value: "status", label: "status", description: "Leer el estado del job" },
				{ value: "logs", label: "logs", description: "Leer logs acotados del job" },
				{ value: "events", label: "events", description: "Leer eventos acotados del ciclo de vida del job" },
				{ value: "delete", label: "delete", description: "Eliminar los artefactos de un job terminado" },
				{
					value: "prune",
					label: "prune",
					description: "Vista previa/prune de artefactos de jobs terminados (--yes para eliminar)",
				},
			];
			const prefix = argumentPrefix.trim().toLowerCase();
			if (!prefix) return items;
			return items.filter((i) => i.value.startsWith(prefix));
		},
		handler: async (args, ctx) => notify(ctx, await handleBgCommand(args, ctx)),
	});

	// Self-heal al startup (solo sesiones persistentes y confiables, donde se poseen jobs):
	// reescribe jobs locales del proyecto cuyo pid registrado está muerto, de `running` stale
	// a `interrupted` terminal, para que el artefacto en disco deje de afirmar `running`.
	// Mejor esfuerzo; nunca dejar que rompa session start.
	pi.on("session_start", async (_event, ctx) => {
		if (!canRunInMode(ctx)) return;
		try {
			await reconcileInterruptedJobs(ctx);
		} catch {
			// ignore: reconcile es bookkeeping no crítico
		}
	});
}
