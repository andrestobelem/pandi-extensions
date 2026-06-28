// pi-bg child-process + log-stream lifecycle: write the status sidecar (serialized per
// job), pipe child output to bounded log sinks with backpressure, contain stream errors,
// finalize a job exactly once, and signal a detached job's process group. Operate on the
// in-process RuntimeJob registry (activeJobs lives in runtime-state.ts). index.ts owns the
// command handlers that spawn the child and wire these together.

import { spawn } from "node:child_process";
import { type WriteStream } from "node:fs";
import * as path from "node:path";
import { activeJobs, appendEvent, nowIso } from "./runtime-state.js";
import { atomicWriteJson } from "./storage.js";
import type { JobState, JobStatus, RuntimeJob } from "./index.js";

// Bound bytes written per job log sink so a chatty trusted job cannot fill the user's disk.
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

// Contain stream 'error' events to the job: without a listener, an 'error' on a
// log WriteStream or child stdout/stderr pipe escalates to uncaughtException and
// would crash the host Pi process (and every in-flight job).
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

// A job is finished once finalize ran or the child has exited/been signalled.
// Cancelling such a job would mislabel a completed run as "cancelled" and could
// signal a PID that the OS has already reaped (possibly reused).
export function isJobFinished(runtime: RuntimeJob): boolean {
	return runtime.finalized || runtime.child.exitCode !== null || runtime.child.signalCode !== null;
}

// Forward a child stream to one or more log sinks while respecting backpressure:
// pause the source when any sink buffers, resume only once every sink has drained.
// Without this, a chatty job can grow the host process memory without bound.
export function pipeWithBackpressure(
	source: NodeJS.ReadableStream | null | undefined,
	sinks: WriteStream[],
	capBytes = MAX_LOG_WRITE_BYTES,
): void {
	if (!source) return;
	// Bound bytes written per sink so a chatty trusted job cannot fill the user's disk.
	// Once capped, stop writing payload and append a single marker (mirrors the read cap).
	const written = sinks.map(() => 0);
	const capped = sinks.map(() => false);
	// A destroyed/errored/capped sink never emits 'drain'. Treat it as non-blocking so a
	// dead or capped log sink can never freeze the source (and thus the child) and leave
	// the job stuck.
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
				sink.write(`\n[log capped at ${capBytes} bytes]\n`);
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
	activeJobs.delete(runtime.jobId);
	closeStreams(runtime);
}

// Run finalize from a child lifecycle event WITHOUT letting a rejected promise
// escape. A failed status write (e.g. status.json rename fails) would otherwise
// reject the discarded `void finalizeJob(...)` promise and, under Node's default
// unhandledRejection behavior, crash the host Pi process and every in-flight job.
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
		if (process.platform !== "win32") return; // a POSIX group signal already covers the children
	}
	runtime.child.kill(signal); // win32 belt-and-suspenders, and the no-pid fallback
}

// Signal a detached job's whole process group by its persisted pid (pgid === pid,
// since jobs are started detached). POSIX uses a negative pid; Windows uses taskkill.
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
