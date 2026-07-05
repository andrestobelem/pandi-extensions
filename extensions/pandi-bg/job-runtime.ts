// Ciclo de vida child-process + log-stream de pandi-bg: escribe el sidecar de status
// (serializado por job), pipea salida del child a log sinks acotados con backpressure,
// contiene errores de stream, finaliza un job exactamente una vez y envía señal al process
// group de un job detached. Opera sobre el registro RuntimeJob in-process (activeJobs vive en
// runtime-state.ts). index.ts posee los command handlers que spawnean el child y cablean esto.

import { spawn } from "node:child_process";
import type { WriteStream } from "node:fs";
import * as path from "node:path";
import type { JobState, JobStatus, RuntimeJob } from "./index.js";
import { activeJobs, appendEvent, nowIso } from "./runtime-state.js";
import { atomicWriteJson } from "./storage.js";

// Acota bytes escritos por log sink de job para que un job confiable verboso no llene el disco.
const MAX_LOG_WRITE_BYTES = 5_000_000;

export async function writeStatus(runtime: RuntimeJob, patch: Partial<JobStatus>): Promise<void> {
	const nextStatus = { ...runtime.status, ...patch, updatedAt: nowIso() };
	runtime.status = nextStatus;
	const previous = runtime.statusWriteChain ?? Promise.resolve();
	const write = previous
		.catch(() => undefined)
		.then(() => atomicWriteJson(path.join(runtime.runDir, "status.json"), nextStatus));
	runtime.statusWriteChain = write;
	await write;
}

function closeStreams(runtime: RuntimeJob): void {
	runtime.stdoutStream.end();
	runtime.stderrStream.end();
	runtime.combinedStream.end();
}

type ErrorEmitter = { on(event: "error", listener: (err: Error) => void): unknown } | null | undefined;

// Contiene eventos 'error' de stream dentro del job: sin listener, un 'error' en un
// WriteStream de log o pipe stdout/stderr del child escala a uncaughtException y
// crashearía el proceso host de Pi (y todo job in-flight).
export function guardStreamErrors(runDir: string, jobId: string, streams: ErrorEmitter[]): void {
	for (const stream of streams) {
		stream?.on("error", (err: Error) => {
			void appendEvent(runDir, {
				event: "log-stream-error",
				jobId,
				error: err?.message ?? String(err),
			});
		});
	}
}

// Un job está terminado cuando corrió finalize, NO solo cuando salió el child directo.
// Con shell:true, el child directo suele ser solo la shell: en Linux (dash) puede forkear
// el trabajo real y salir, seteando child.exitCode/signalCode mientras el process GROUP
// sigue vivo sosteniendo los log pipes (issue #9). Tratar eso como "finished" omitía
// cancel y la escalada a SIGKILL, dejando el job trabado para siempre con un sobreviviente
// huérfano. Las señales de grupo siguen válidas hasta finalize ('close' dispara recién
// después de que el grupo libera los pipes), pgid === child.pid por spawn detached, y toda
// ruta de señal está contenida con try/catch, así que ESRCH en un grupo ya reaped es inocuo.
export function isJobFinished(runtime: RuntimeJob): boolean {
	return runtime.finalized;
}

// Reenvía un stream del child a uno o más log sinks respetando backpressure: pausa la fuente
// cuando cualquier sink bufferiza, y reanuda solo cuando todos los sinks drenaron. Sin esto,
// un job verboso puede hacer crecer sin límite la memoria del proceso host.
export function pipeWithBackpressure(
	source: NodeJS.ReadableStream | null | undefined,
	sinks: WriteStream[],
	capBytes = MAX_LOG_WRITE_BYTES,
): void {
	if (!source) return;
	// Acota bytes escritos por sink para que un job confiable verboso no llene el disco.
	// Al llegar al tope, deja de escribir payload y agrega un único marcador (espeja el cap de lectura).
	const written = sinks.map(() => 0);
	const capped = sinks.map(() => false);
	// Un sink destruido/con error/topeado nunca emite 'drain'. Tratarlo como no bloqueante
	// evita que un log sink muerto o topeado congele la fuente (y por ende el child) y deje
	// el job trabado.
	const maybeResume = (): void => {
		if (sinks.every((sink, i) => sink.destroyed || capped[i] || !sink.writableNeedDrain)) source.resume();
	};
	source.on("data", (chunk: Buffer) => {
		let blocked = false;
		sinks.forEach((sink, i) => {
			if (sink.destroyed || capped[i]) return;
			if (written[i] + chunk.length > capBytes) {
				const remaining = Math.max(0, capBytes - written[i]);
				if (remaining > 0) sink.write(chunk.subarray(0, remaining));
				sink.write(`\n[log topado en ${capBytes} bytes]\n`);
				capped[i] = true;
				return;
			}
			written[i] += chunk.length;
			if (!sink.write(chunk)) blocked = true;
		});
		if (blocked) source.pause();
	});
	for (const sink of sinks) {
		sink.on("drain", maybeResume);
		sink.on("close", maybeResume);
		sink.on("error", maybeResume);
	}
}

export async function finalizeJob(
	runtime: RuntimeJob,
	exitCode: number | null,
	signal: NodeJS.Signals | null,
	error?: Error,
): Promise<void> {
	if (runtime.finalized) return;
	runtime.finalized = true;
	if (runtime.cancelTimer) clearTimeout(runtime.cancelTimer);
	const state: JobState = runtime.status.cancelRequested
		? "cancelled"
		: error
			? "failed"
			: exitCode === 0
				? "completed"
				: "failed";
	// Cleanup (remoción del registro + cierre de streams) corre en finally para que una
	// escritura de status/event que lanza (disco lleno, límite de FD, runDir desaparecido)
	// no deje el job medio finalizado: trabado en activeJobs con stream fds filtrados. El
	// error de escritura aún propaga para que safeFinalize lo loguee.
	try {
		await writeStatus(runtime, {
			state,
			completedAt: nowIso(),
			exitCode,
			signal: signal ?? null,
			...(error ? { error: error.message } : {}),
		});
		await appendEvent(runtime.runDir, {
			event: "finish",
			jobId: runtime.jobId,
			state,
			exitCode,
			signal,
			error: error?.message,
		});
	} finally {
		activeJobs.delete(runtime.jobId);
		closeStreams(runtime);
	}
}

// Ejecuta finalize desde un evento de ciclo de vida del child SIN dejar escapar una promise
// rechazada. Una escritura de status fallida (p. ej. falla el rename de status.json) de otro
// modo rechazaría la promise descartada `void finalizeJob(...)` y, bajo el comportamiento
// default de unhandledRejection de Node, crashearía el proceso host de Pi y todo job in-flight.
export function safeFinalize(
	runtime: RuntimeJob,
	exitCode: number | null,
	signal: NodeJS.Signals | null,
	error?: Error,
): void {
	void finalizeJob(runtime, exitCode, signal, error).catch((err: unknown) => {
		void appendEvent(runtime.runDir, {
			event: "finalize-error",
			jobId: runtime.jobId,
			error: (err as Error)?.message ?? String(err),
		});
	});
}

export function killRuntime(runtime: RuntimeJob, signal: NodeJS.Signals): void {
	if (isJobFinished(runtime)) return;
	if (runtime.child.pid) {
		signalProcessGroup(runtime.child.pid, signal);
		if (process.platform !== "win32") return; // una señal de grupo POSIX ya cubre a los hijos
	}
	runtime.child.kill(signal); // doble cobertura para win32, y fallback sin pid
}

// Envía señal a todo el process group de un job detached por su pid persistido (pgid === pid,
// porque los jobs arrancan detached). POSIX usa pid negativo; Windows usa taskkill.
export function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
	if (process.platform === "win32") {
		spawn("taskkill", ["/pid", String(pid), "/T", ...(signal === "SIGKILL" ? ["/F"] : [])], {
			stdio: "ignore",
			windowsHide: true,
		}).on("error", () => undefined);
		return;
	}
	process.kill(-pid, signal);
}
