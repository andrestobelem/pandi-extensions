/**
 * Local `/bg` background jobs (M2a).
 *
 * Scope is intentionally narrow: human slash commands only, local child_process runner,
 * trusted projects only for starts, no Supacode runner, and no mutating LLM tool.
 */

import { CONFIG_DIR_NAME, getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { spawn, type ChildProcess } from "node:child_process";
import * as crypto from "node:crypto";
import { createWriteStream, type WriteStream } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const BG_DIR = "bg";
const RUNS_DIR = "runs";
const MAX_LOG_BYTES = 20_000;
const MAX_JSON_BYTES = 1_000_000;
const CANCEL_GRACE_MS = 750;
const PLAN_MODE_GUARD_SYMBOL = Symbol.for("pi-dynamic-workflows.plan-mode.guard");

type JobState = "starting" | "running" | "completed" | "failed" | "cancelled" | "stale" | "unknown";

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

interface CandidateRunRoot {
	root: string;
	baseDir: string;
}

interface JobStatus {
	jobId: string;
	state: JobState;
	pid?: number;
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

function stableHash(value: string): string {
	return crypto.createHash("sha1").update(value).digest("hex").slice(0, 12);
}

function nowIso(): string {
	return new Date().toISOString();
}

function getProjectBgRoot(ctx: ExtensionContext): string {
	return path.join(ctx.cwd, CONFIG_DIR_NAME, BG_DIR);
}

function getGlobalBgRoot(_ctx: ExtensionContext): string {
	return path.join(getAgentDir(), BG_DIR);
}

function candidateRunRoots(ctx: ExtensionContext): CandidateRunRoot[] {
	const roots: CandidateRunRoot[] = [];
	if (ctx.isProjectTrusted()) roots.push({ root: path.join(getProjectBgRoot(ctx), RUNS_DIR), baseDir: ctx.cwd });
	const globalRuns = path.join(getGlobalBgRoot(ctx), RUNS_DIR, stableHash(ctx.cwd));
	if (!roots.some((entry) => entry.root === globalRuns)) roots.push({ root: globalRuns, baseDir: getAgentDir() });
	return roots;
}

function validJobId(jobId: string): boolean {
	return /^(?!\.{1,2}$)[A-Za-z0-9][A-Za-z0-9._-]*$/.test(jobId);
}

function generateJobId(): string {
	return `bg-${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`;
}

async function lstatPlainDirectory(dir: string): Promise<boolean> {
	try {
		const stat = await fs.lstat(dir);
		return stat.isDirectory() && !stat.isSymbolicLink();
	} catch {
		return false;
	}
}

async function lstatPlainDirectoryChain(baseDir: string, dir: string): Promise<boolean> {
	const base = path.resolve(baseDir);
	const target = path.resolve(dir);
	const relative = path.relative(base, target);
	if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return false;
	let current = base;
	for (const part of relative.split(path.sep).filter(Boolean)) {
		current = path.join(current, part);
		if (!(await lstatPlainDirectory(current))) return false;
	}
	return true;
}

async function ensurePlainDirectory(dir: string): Promise<void> {
	try {
		await fs.mkdir(dir);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
	}
	if (!(await lstatPlainDirectory(dir))) throw new Error(`Refusing to use non-directory or symlink: ${dir}`);
}

async function createRunDir(ctx: ExtensionContext, jobId: string): Promise<string> {
	const piDir = path.join(ctx.cwd, CONFIG_DIR_NAME);
	const bgDir = path.join(piDir, BG_DIR);
	const runsDir = path.join(bgDir, RUNS_DIR);
	await ensurePlainDirectory(piDir);
	await ensurePlainDirectory(bgDir);
	await ensurePlainDirectory(runsDir);
	const runDir = path.join(runsDir, jobId);
	await ensurePlainDirectory(runDir);
	return runDir;
}

async function isRegularFile(file: string): Promise<boolean> {
	try {
		const stat = await fs.lstat(file);
		return stat.isFile() && stat.size <= MAX_JSON_BYTES;
	} catch {
		return false;
	}
}

async function readJson(file: string): Promise<Record<string, unknown> | undefined> {
	try {
		if (!(await isRegularFile(file))) return undefined;
		const parsed = JSON.parse(await fs.readFile(file, "utf8"));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

export async function atomicWriteJson(file: string, value: unknown): Promise<void> {
	const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString("hex")}.tmp`);
	await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
	try {
		await fs.rename(tmp, file);
	} catch (err) {
		await fs.rm(tmp, { force: true }).catch(() => undefined);
		throw err;
	}
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

function deriveState(jobId: string, status: Record<string, unknown> | undefined): JobState | string {
	const state = asString(status?.state) ?? "unknown";
	if ((state === "starting" || state === "running") && !activeJobs.has(jobId)) return "stale";
	return state;
}

function decorateStatus(jobId: string, raw: Record<string, unknown>): Record<string, unknown> {
	const copy: Record<string, unknown> = { ...raw };
	const state = asString(copy.state);
	const active = activeJobs.has(jobId);
	if ((state === "starting" || state === "running") && !active) {
		copy.persistedState = state;
		copy.state = "stale";
	}
	copy.active = active;
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
export function pipeWithBackpressure(source: NodeJS.ReadableStream | null | undefined, sinks: WriteStream[]): void {
	if (!source) return;
	// A destroyed/errored sink never emits 'drain'. Treat it as non-blocking so a dead
	// log sink can never freeze the source (and thus the child) and leave the job stuck.
	const maybeResume = (): void => {
		if (sinks.every((sink) => sink.destroyed || !sink.writableNeedDrain)) source.resume();
	};
	source.on("data", (chunk: Buffer) => {
		let blocked = false;
		for (const sink of sinks) {
			if (!sink.destroyed && !sink.write(chunk)) blocked = true;
		}
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

async function handlePlan(command: string): Promise<BgResponse> {
	if (!command.trim()) return response("Usage: /bg plan <command>", undefined, "warning");
	return response(
		[
			"Dry run only — no background job was started.",
			"",
			"Planned command:",
			command.trim(),
			"",
			"Use /bg start <command> in a trusted TUI/RPC session to run it.",
		].join("\n"),
		{ action: "plan", command: command.trim(), dryRun: true },
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

	await writeStatus(runtime, { state: "running", pid: child.pid });
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

async function handleStatus(ctx: ExtensionContext, jobId: string): Promise<BgResponse> {
	if (!jobId || !validJobId(jobId)) return response("Usage: /bg status <jobId>", undefined, "warning");
	const runDir = await findJobDir(ctx, jobId);
	if (!runDir) return response(`Background job not found: ${jobId}`, { jobId, found: false }, "warning");
	const job = (await readJson(path.join(runDir, "job.json"))) ?? {};
	const rawStatus = (await readJson(path.join(runDir, "status.json"))) ?? {};
	const status = decorateStatus(jobId, rawStatus);
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

async function handleLogs(ctx: ExtensionContext, jobId: string): Promise<BgResponse> {
	if (!jobId || !validJobId(jobId)) return response("Usage: /bg logs <jobId>", undefined, "warning");
	const runDir = await findJobDir(ctx, jobId);
	if (!runDir) return response(`Background job not found: ${jobId}`, { jobId, found: false }, "warning");
	const combined = await readBoundedLog(path.join(runDir, "combined.log"));
	if (combined !== undefined) return response(combined || "(empty log)", { jobId, source: "combined.log", truncatedTo: MAX_LOG_BYTES });
	const stdout = await readBoundedLog(path.join(runDir, "stdout.log"));
	const stderr = await readBoundedLog(path.join(runDir, "stderr.log"));
	if (stdout === undefined && stderr === undefined) return response(`No logs found for ${jobId}.`, { jobId, found: true, logs: false }, "warning");
	return response([stdout !== undefined ? `== stdout ==\n${stdout}` : undefined, stderr !== undefined ? `== stderr ==\n${stderr}` : undefined].filter(Boolean).join("\n"), {
		jobId,
		source: "stdout/stderr",
		truncatedTo: MAX_LOG_BYTES,
	});
}

async function handleBgCommand(args: string, ctx: ExtensionContext): Promise<BgResponse> {
	try {
		const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(args.trimStart());
		if (!match) {
			return response("Usage: /bg plan <command> | /bg start <command> | /bg cancel <jobId> | /bg list | /bg status <jobId> | /bg logs <jobId>", undefined, "warning");
		}
		const subcommand = match[1] ?? "";
		const tail = match[2] ?? "";
		switch (subcommand.toLowerCase()) {
			case "plan":
				return await handlePlan(tail);
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
			default:
				return response(`Unknown /bg subcommand: ${subcommand}. Supported: plan, start, cancel, list, status, logs.`, undefined, "warning");
		}
	} catch (err) {
		return response(`/bg failed: ${(err as Error).message}`, { error: (err as Error).message }, "error");
	}
}

export default function bgExtension(pi: ExtensionAPI): void {
	pi.registerCommand("bg", {
		description: "Background jobs: /bg plan <command> | /bg start <command> | /bg cancel <jobId> | /bg list | /bg status <jobId> | /bg logs <jobId>",
		getArgumentCompletions: (argumentPrefix: string) => {
			const items = [
				{ value: "plan", label: "plan", description: "Dry-run a background command plan" },
				{ value: "start", label: "start", description: "Start a background job" },
				{ value: "cancel", label: "cancel", description: "Cancel an active background job" },
				{ value: "list", label: "list", description: "List background job artifacts" },
				{ value: "status", label: "status", description: "Read job status" },
				{ value: "logs", label: "logs", description: "Read bounded job logs" },
			];
			const prefix = argumentPrefix.trim().toLowerCase();
			if (!prefix) return items;
			return items.filter((i) => i.value.startsWith(prefix));
		},
		handler: async (args, ctx) => notify(ctx, await handleBgCommand(args, ctx)),
	});
}
