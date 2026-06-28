/**
 * Local `/bg` background jobs (M2a).
 *
 * Scope is intentionally narrow: human slash commands only, local child_process runner,
 * trusted projects only for starts, no Supacode runner, and no mutating LLM tool.
 */

import { CONFIG_DIR_NAME, getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import * as crypto from "node:crypto";
import { createWriteStream, readFileSync, type WriteStream } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	atomicWriteJson,
	candidateRunRoots,
	createRunDir,
	generateJobId,
	getProjectBgRoot,
	lstatPlainDirectory,
	lstatPlainDirectoryChain,
	readJson,
	RUNS_DIR,
	validJobId,
} from "./storage.js";
export { atomicWriteJson };

const MAX_LOG_BYTES = 20_000;
const MAX_LOG_WRITE_BYTES = 5_000_000;
const CANCEL_GRACE_MS = 750;
const PLAN_MODE_GUARD_SYMBOL = Symbol.for("pi-dynamic-workflows.plan-mode.guard");

type JobState = "starting" | "running" | "completed" | "failed" | "cancelled" | "orphaned" | "interrupted" | "stale" | "unknown";

interface PlanModeGuard {
	isActive(): boolean;
}

interface JobSummary {
	jobId: string;
	command?: string;
	state?: JobState | string;
	createdAt?: string;
	updatedAt?: string;
	artifactsDir: string;
}


interface JobStatus {
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

interface RuntimeJob {
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

const activeJobs = new Map<string, RuntimeJob>();


function nowIso(): string {
	return new Date().toISOString();
}


async function appendEvent(runDir: string, event: Record<string, unknown>): Promise<void> {
	await fs.appendFile(path.join(runDir, "events.jsonl"), `${JSON.stringify({ time: nowIso(), ...event })}\n`, "utf8").catch(() => undefined);
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

type Liveness = "alive" | "dead" | "unknown";

// Best-effort, synchronous liveness check. process.kill(pid, 0) sends NO signal; it
// only asks the OS whether a process with that pid exists. Cross-platform (Windows
// included). NOTE: a pid can be reused after the original process is reaped, so
// "alive" means "some process holds this pid", not "our job is still running" — the
// reason we only use this to LABEL a read, never to signal a persisted pid.
// A pid we can actually probe: a positive integer. Excludes undefined, 0, negatives
// (e.g. process-group ids), and non-integers.
function isUsablePid(pid: number | undefined): pid is number {
	return typeof pid === "number" && Number.isInteger(pid) && pid > 0;
}

// Capture a stable per-process start identity so a later probe can distinguish our
// job's process from an unrelated one that reused its pid. Best-effort, degrading
// across platforms: Linux reads /proc (no subprocess); macOS/BSD shell out to
// `ps -o lstart=`; anything else (e.g. Windows) returns undefined and callers fall
// back to the existing best-effort liveness label.
export function readProcessStartId(pid: number | undefined): string | undefined {
	if (!isUsablePid(pid)) return undefined;
	try {
		if (process.platform === "linux") {
			const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
			// comm can contain spaces/parens, so parse fields after the last ')'. starttime is
			// field 22 (1-indexed) => index 19 of the post-comm tokens.
			const afterComm = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/);
			const starttime = afterComm[19];
			return starttime ? `lin:${starttime}` : undefined;
		}
		if (process.platform === "darwin" || process.platform.endsWith("bsd")) {
			const res = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" });
			const out = res.status === 0 ? (res.stdout ?? "").trim() : "";
			return out ? `ps:${out}` : undefined;
		}
		return undefined;
	} catch {
		return undefined;
	}
}

// Confirm a live pid still belongs to OUR job by comparing its current start identity
// to the one recorded at spawn. "same" = verified our process; "different" = the pid
// was reused (our process is gone); "unknown" = cannot tell (no recorded id, or the
// current id is unreadable) => callers keep best-effort behavior and never claim reuse.
export function verifyProcessIdentity(pid: number | undefined, recordedStartId: string | undefined): "same" | "different" | "unknown" {
	if (!recordedStartId) return "unknown";
	const current = readProcessStartId(pid);
	if (current === undefined) return "unknown";
	return current === recordedStartId ? "same" : "different";
}

export function probeProcessAlive(pid: number | undefined): Liveness {
	if (!isUsablePid(pid)) return "unknown";
	try {
		process.kill(pid, 0);
		return "alive";
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "EPERM") return "alive"; // exists but owned by another user
		if (code === "ESRCH") return "dead"; // no such process
		return "unknown";
	}
}

// Single read-time projection of the persisted state (the only states a writer can
// know: starting/running/completed/failed/cancelled). When a job is persisted as
// starting/running but is NOT owned by this session, probe the recorded pid to
// distinguish an orphaned-but-alive process from one that died while Pi was down,
// falling back to `stale` only when the pid is unprobeable. Never persisted, never
// signals: cancel still refuses any persisted pid.
function projectState(jobId: string, persisted: string | undefined, pid: number | undefined): { state: JobState; persistedState?: string; hint?: string } {
	if ((persisted === "starting" || persisted === "running") && !activeJobs.has(jobId)) {
		const live = probeProcessAlive(pid);
		if (live === "alive") {
			return {
				state: "orphaned",
				persistedState: persisted,
				hint: `PID ${pid} may still be running (or the PID was reused). Verify before using kill -- -${pid} / taskkill; /bg cancel will not signal a persisted PID.`,
			};
		}
		if (live === "dead") return { state: "interrupted", persistedState: persisted };
		return { state: "stale", persistedState: persisted };
	}
	return { state: (persisted ?? "unknown") as JobState };
}

function deriveState(jobId: string, status: Record<string, unknown> | undefined): JobState | string {
	return projectState(jobId, asString(status?.state) ?? "unknown", asNumber(status?.pid)).state;
}

function decorateStatus(jobId: string, raw: Record<string, unknown>): Record<string, unknown> {
	const copy: Record<string, unknown> = { ...raw };
	const projected = projectState(jobId, asString(copy.state), asNumber(copy.pid));
	copy.state = projected.state;
	if (projected.persistedState !== undefined) copy.persistedState = projected.persistedState;
	if (projected.hint !== undefined) copy.hint = projected.hint;
	copy.active = activeJobs.has(jobId);
	return copy;
}

async function listJobs(ctx: ExtensionContext): Promise<JobSummary[]> {
	const jobs: JobSummary[] = [];
	for (const { root, baseDir } of candidateRunRoots(ctx)) {
		if (!(await lstatPlainDirectoryChain(baseDir, root))) continue;
		let entries: Array<{ name: string; isDirectory(): boolean }>;
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

// Session-start self-heal: a fresh Pi process owns no jobs (activeJobs is empty),
// so any project-local job persisted as starting/running is from a previous run.
// Probe its recorded pid; a DEAD pid means the process is truly gone (Pi died
// before finalize), so atomically rewrite the artifact to a terminal `interrupted`
// state. Live/unprobeable jobs are left untouched (the read-time projection still
// surfaces orphaned/stale). Writing `interrupted` only on a confirmed-dead pid is
// what avoids the pid-reuse hazard: a dead pid can never be our live job, so the
// terminal state is always correct. Project root only (the only root pi-bg writes,
// and only when trusted); best-effort — never throws into session_start.
export async function reconcileInterruptedJobs(ctx: ExtensionContext): Promise<number> {
	if (!ctx.isProjectTrusted()) return 0;
	const root = path.join(getProjectBgRoot(ctx), RUNS_DIR);
	if (!(await lstatPlainDirectoryChain(ctx.cwd, root))) return 0;
	let entries: Array<{ name: string; isDirectory(): boolean }>;
	try {
		entries = await fs.readdir(root, { withFileTypes: true });
	} catch {
		return 0;
	}
	let reconciled = 0;
	for (const entry of entries) {
		if (!entry.isDirectory() || !validJobId(entry.name) || activeJobs.has(entry.name)) continue;
		const runDir = path.join(root, entry.name);
		if (!(await lstatPlainDirectory(runDir))) continue;
		const status = await readJson(path.join(runDir, "status.json"));
		const state = asString(status?.state);
		if (!state || !RECONCILABLE_STATES.has(state)) continue;
		const pid = asNumber(status?.pid);
		const live = probeProcessAlive(pid);
		// Dead pid => process gone. Alive but a different start identity => the pid was
		// reused, so our process is also gone. Both are positive evidence to terminalize;
		// an alive pid we cannot disprove (same/unknown) stays a read-time orphaned/stale.
		const cause = live === "dead" ? "pid-dead" : live === "alive" && verifyProcessIdentity(pid, asString(status?.startId)) === "different" ? "pid-reused" : undefined;
		if (!cause) continue;
		const now = nowIso();
		try {
			await atomicWriteJson(path.join(runDir, "status.json"), { ...status, state: "interrupted", completedAt: now, updatedAt: now, reason: "session-start-reconcile" });
			await appendEvent(runDir, { event: "reconcile-interrupted", jobId: entry.name, pid: pid ?? null, persistedState: state, cause });
			reconciled++;
		} catch {
			// Best-effort: leave the artifact untouched if the atomic rewrite fails.
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
	if (ctx.mode === "print") {
		console.log(result.message);
		return;
	}
	if (ctx.hasUI) ctx.ui.notify(result.message, result.type ?? "info");
}

function planModeActive(): boolean {
	const guard = (globalThis as Record<symbol, PlanModeGuard | undefined>)[PLAN_MODE_GUARD_SYMBOL];
	try {
		return guard?.isActive() === true;
	} catch {
		return false;
	}
}

function rejectInPlanMode(action: "start" | "cancel"): BgResponse | undefined {
	if (!planModeActive()) return undefined;
	return response(`Cannot /bg ${action} while plan mode is active. Approve or exit /plan first.`, { action, blockedBy: "plan-mode" }, "warning");
}

function canRunInMode(ctx: ExtensionContext): boolean {
	return ctx.mode === "tui" || ctx.mode === "rpc";
}

async function writeStatus(runtime: RuntimeJob, patch: Partial<JobStatus>): Promise<void> {
	const nextStatus = { ...runtime.status, ...patch, updatedAt: nowIso() };
	runtime.status = nextStatus;
	const previous = runtime.statusWriteChain ?? Promise.resolve();
	const write = previous.catch(() => undefined).then(() => atomicWriteJson(path.join(runtime.runDir, "status.json"), nextStatus));
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
			void appendEvent(runDir, { event: "log-stream-error", jobId, error: err?.message ?? String(err) });
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
export function pipeWithBackpressure(source: NodeJS.ReadableStream | null | undefined, sinks: WriteStream[], capBytes = MAX_LOG_WRITE_BYTES): void {
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

export async function finalizeJob(runtime: RuntimeJob, exitCode: number | null, signal: NodeJS.Signals | null, error?: Error): Promise<void> {
	if (runtime.finalized) return;
	runtime.finalized = true;
	if (runtime.cancelTimer) clearTimeout(runtime.cancelTimer);
	const state: JobState = runtime.status.cancelRequested ? "cancelled" : error ? "failed" : exitCode === 0 ? "completed" : "failed";
	await writeStatus(runtime, {
		state,
		completedAt: nowIso(),
		exitCode,
		signal: signal ?? null,
		...(error ? { error: error.message } : {}),
	});
	await appendEvent(runtime.runDir, { event: "finish", jobId: runtime.jobId, state, exitCode, signal, error: error?.message });
	activeJobs.delete(runtime.jobId);
	closeStreams(runtime);
}

// Run finalize from a child lifecycle event WITHOUT letting a rejected promise
// escape. A failed status write (e.g. status.json rename fails) would otherwise
// reject the discarded `void finalizeJob(...)` promise and, under Node's default
// unhandledRejection behavior, crash the host Pi process and every in-flight job.
export function safeFinalize(runtime: RuntimeJob, exitCode: number | null, signal: NodeJS.Signals | null, error?: Error): void {
	void finalizeJob(runtime, exitCode, signal, error).catch((err: unknown) => {
		void appendEvent(runtime.runDir, { event: "finalize-error", jobId: runtime.jobId, error: (err as Error)?.message ?? String(err) });
	});
}

async function handlePreview(command: string): Promise<BgResponse> {
	if (!command.trim()) return response("Usage: /bg preview <command>", undefined, "warning");
	return response(
		[
			"Dry run only — no background job was started.",
			"",
			"Command to run:",
			command.trim(),
			"",
			"Use /bg start <command> in a trusted TUI/RPC session to run it.",
		].join("\n"),
		{ action: "preview", command: command.trim(), dryRun: true },
	);
}

async function handleStart(ctx: ExtensionContext, command: string): Promise<BgResponse> {
	const blocked = rejectInPlanMode("start");
	if (blocked) return blocked;
	const trimmed = command.trim();
	if (!trimmed) return response("Usage: /bg start <command>", undefined, "warning");
	if (!canRunInMode(ctx)) return response("Cannot /bg start outside a persistent TUI/RPC session.", { action: "start", blockedBy: "mode", mode: ctx.mode }, "warning");
	if (!ctx.isProjectTrusted()) return response("Cannot /bg start in an untrusted project.", { action: "start", blockedBy: "trust" }, "warning");

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
	const initialStatus: JobStatus = { jobId, state: "starting", updatedAt: createdAt, startedAt: createdAt, cancelRequested: false };
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
			`Started background job ${jobId}.`,
			`Artifacts: ${runDir}`,
			`Status: /bg status ${jobId}`,
			`Logs: /bg logs ${jobId}`,
		].join("\n"),
		{ action: "start", jobId, artifactsDir: runDir, pid: child.pid },
	);
}

function killRuntime(runtime: RuntimeJob, signal: NodeJS.Signals): void {
	if (isJobFinished(runtime)) return;
	if (process.platform !== "win32" && runtime.child.pid) {
		process.kill(-runtime.child.pid, signal);
		return;
	}
	if (process.platform === "win32" && runtime.child.pid) {
		spawn("taskkill", ["/pid", String(runtime.child.pid), "/T", ...(signal === "SIGKILL" ? ["/F"] : [])], { stdio: "ignore", windowsHide: true }).on("error", () => undefined);
	}
	runtime.child.kill(signal);
}

async function handleCancel(jobId: string): Promise<BgResponse> {
	const blocked = rejectInPlanMode("cancel");
	if (blocked) return blocked;
	const trimmed = jobId.trim();
	if (!trimmed || !validJobId(trimmed)) return response("Usage: /bg cancel <jobId>", undefined, "warning");
	const runtime = activeJobs.get(trimmed);
	if (!runtime) {
		return response(`Background job ${trimmed} is not active in this session; no process was killed.`, { action: "cancel", jobId: trimmed, active: false }, "warning");
	}
	if (isJobFinished(runtime)) {
		return response(`Background job ${trimmed} has already finished; nothing to cancel.`, { action: "cancel", jobId: trimmed, active: false, alreadyFinished: true }, "warning");
	}
	if (runtime.status.cancelRequested) {
		return response(`Cancellation already requested for background job ${trimmed}.`, { action: "cancel", jobId: trimmed, active: true, duplicate: true }, "warning");
	}

	await writeStatus(runtime, { cancelRequested: true });
	await appendEvent(runtime.runDir, { event: "cancel-requested", jobId: trimmed, pid: runtime.child.pid });
	try {
		killRuntime(runtime, "SIGTERM");
	} catch (err) {
		await appendEvent(runtime.runDir, { event: "cancel-sigterm-error", jobId: trimmed, error: (err as Error).message });
	}
	runtime.cancelTimer = setTimeout(() => {
		if (runtime.finalized) return;
		try {
			killRuntime(runtime, "SIGKILL");
			void appendEvent(runtime.runDir, { event: "cancel-sigkill", jobId: trimmed, pid: runtime.child.pid });
		} catch (err) {
			void appendEvent(runtime.runDir, { event: "cancel-sigkill-error", jobId: trimmed, error: (err as Error).message });
		}
	}, CANCEL_GRACE_MS);
	return response(`Cancel requested for background job ${trimmed}.`, { action: "cancel", jobId: trimmed, active: true });
}

async function handleList(ctx: ExtensionContext): Promise<BgResponse> {
	const jobs = await listJobs(ctx);
	if (jobs.length === 0) return response("No background jobs found.", { jobs: [] });
	return response(["Background jobs:", ...jobs.map(formatJob)].join("\n"), { jobs });
}

// Validate a job id and resolve its symlink-safe run directory, or return the
// shared usage/not-found warning so every read subcommand behaves identically.
async function resolveRunDir(ctx: ExtensionContext, jobId: string, usage: string): Promise<string | BgResponse> {
	if (!jobId || !validJobId(jobId)) return response(usage, undefined, "warning");
	const runDir = await findJobDir(ctx, jobId);
	if (!runDir) return response(`Background job not found: ${jobId}`, { jobId, found: false }, "warning");
	return runDir;
}

async function handleStatus(ctx: ExtensionContext, jobId: string): Promise<BgResponse> {
	const runDir = await resolveRunDir(ctx, jobId, "Usage: /bg status <jobId>");
	if (typeof runDir !== "string") return runDir;
	const job = (await readJson(path.join(runDir, "job.json"))) ?? {};
	const rawStatus = (await readJson(path.join(runDir, "status.json"))) ?? {};
	const status = decorateStatus(jobId, rawStatus);
	// Refine a best-effort `orphaned` with a single identity probe (one job => one ps on
	// macOS/BSD; /bg list deliberately does NOT do this to avoid N subprocesses): a reused
	// pid downgrades to `interrupted`; a verified pid is marked so the operator can trust it.
	if (status.state === "orphaned") {
		const pid = asNumber(status.pid);
		const identity = verifyProcessIdentity(pid, asString(status.startId));
		if (identity === "different") {
			status.state = "interrupted";
			delete status.hint;
			status.interruptedCause = "pid-reused";
		} else if (identity === "same") {
			status.identity = "verified";
			status.hint = `PID ${pid} is verified still running (same start identity). Stop it with kill -- -${pid} / taskkill; /bg cancel will not signal a persisted PID.`;
		}
	}
	return response(JSON.stringify({ jobId, artifactsDir: runDir, job, status }, null, 2), { jobId, artifactsDir: runDir, job, status });
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
		// A byte-bounded tail can start mid UTF-8 sequence; drop leading continuation
		// bytes (0b10xxxxxx) so the first character decodes cleanly instead of as U+FFFD.
		let start = 0;
		if (truncated) {
			while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start++;
		}
		const data = buffer.subarray(start).toString("utf8");
		if (!truncated) return data;
		return `[truncated to last ${MAX_LOG_BYTES} bytes]\n${data}`;
	} catch {
		return undefined;
	} finally {
		await handle?.close().catch(() => undefined);
	}
}

// Read a bounded, symlink-safe artifact tail shaped as a /bg response, or undefined
// when the artifact is absent so callers can fall back to another source.
async function boundedArtifactResponse(runDir: string, jobId: string, file: string, source: string, emptyText: string): Promise<BgResponse | undefined> {
	const text = await readBoundedLog(path.join(runDir, file));
	if (text === undefined) return undefined;
	return response(text || emptyText, { jobId, source, truncatedTo: MAX_LOG_BYTES });
}

async function handleLogs(ctx: ExtensionContext, jobId: string): Promise<BgResponse> {
	const runDir = await resolveRunDir(ctx, jobId, "Usage: /bg logs <jobId>");
	if (typeof runDir !== "string") return runDir;
	const combined = await boundedArtifactResponse(runDir, jobId, "combined.log", "combined.log", "(empty log)");
	if (combined) return combined;
	const stdout = await readBoundedLog(path.join(runDir, "stdout.log"));
	const stderr = await readBoundedLog(path.join(runDir, "stderr.log"));
	if (stdout === undefined && stderr === undefined) return response(`No logs found for ${jobId}.`, { jobId, found: true, logs: false }, "warning");
	return response([stdout !== undefined ? `== stdout ==\n${stdout}` : undefined, stderr !== undefined ? `== stderr ==\n${stderr}` : undefined].filter(Boolean).join("\n"), {
		jobId,
		source: "stdout/stderr",
		truncatedTo: MAX_LOG_BYTES,
	});
}

// Surface the structured lifecycle journal (start/running/cancel-*/finish/
// reconcile-interrupted/finalize-error). It explains WHY a job ended
// failed/cancelled/interrupted — evidence that status.json alone does not carry.
// Bounded/symlink-safe via the same readBoundedLog path as /bg logs.
async function handleEvents(ctx: ExtensionContext, jobId: string): Promise<BgResponse> {
	const runDir = await resolveRunDir(ctx, jobId, "Usage: /bg events <jobId>");
	if (typeof runDir !== "string") return runDir;
	const events = await boundedArtifactResponse(runDir, jobId, "events.jsonl", "events.jsonl", "(no events)");
	if (events) return events;
	return response(`No events found for ${jobId}.`, { jobId, found: true, events: false }, "warning");
}

async function handleBgCommand(args: string, ctx: ExtensionContext): Promise<BgResponse> {
	try {
		const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(args.trimStart());
		if (!match) {
			return response("Usage: /bg preview <command> | /bg start <command> | /bg cancel <jobId> | /bg list | /bg status <jobId> | /bg logs <jobId> | /bg events <jobId>", undefined, "warning");
		}
		const subcommand = match[1] ?? "";
		const tail = match[2] ?? "";
		switch (subcommand.toLowerCase()) {
			case "preview":
			case "plan": // deprecated alias of preview
				return await handlePreview(tail);
			case "start":
				return await handleStart(ctx, tail);
			case "cancel":
				return await handleCancel(tail.trim());
			case "list":
				return await handleList(ctx);
			case "status":
				return await handleStatus(ctx, tail.trim());
			case "logs":
				return await handleLogs(ctx, tail.trim());
			case "events":
				return await handleEvents(ctx, tail.trim());
			default:
				return response(`Unknown /bg subcommand: ${subcommand}. Supported: preview, start, cancel, list, status, logs, events.`, undefined, "warning");
		}
	} catch (err) {
		return response(`/bg failed: ${(err as Error).message}`, { error: (err as Error).message }, "error");
	}
}

export default function bgExtension(pi: ExtensionAPI): void {
	pi.registerCommand("bg", {
		description: "Background jobs: /bg preview <command> | /bg start <command> | /bg cancel <jobId> | /bg list | /bg status <jobId> | /bg logs <jobId> | /bg events <jobId>",
		getArgumentCompletions: (argumentPrefix: string) => {
			const items = [
				{ value: "preview", label: "preview", description: "Dry-run (preview) a background command" },
				{ value: "start", label: "start", description: "Start a background job" },
				{ value: "cancel", label: "cancel", description: "Cancel an active background job" },
				{ value: "list", label: "list", description: "List background job artifacts" },
				{ value: "status", label: "status", description: "Read job status" },
				{ value: "logs", label: "logs", description: "Read bounded job logs" },
				{ value: "events", label: "events", description: "Read bounded job lifecycle events" },
			];
			const prefix = argumentPrefix.trim().toLowerCase();
			if (!prefix) return items;
			return items.filter((i) => i.value.startsWith(prefix));
		},
		handler: async (args, ctx) => notify(ctx, await handleBgCommand(args, ctx)),
	});

	// Self-heal at startup (only persistent, trusted sessions, where jobs are owned):
	// rewrite project-local jobs whose recorded pid is dead from a stale `running` to a
	// terminal `interrupted`, so the on-disk artifact stops claiming `running` forever.
	// Best-effort; never let it break session start.
	pi.on("session_start", async (_event, ctx) => {
		if (!canRunInMode(ctx)) return;
		try {
			await reconcileInterruptedJobs(ctx);
		} catch {
			// ignore: reconcile is non-critical bookkeeping
		}
	});
}
