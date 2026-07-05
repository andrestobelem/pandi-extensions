/**
 * Local `/bg` background jobs (M2a).
 *
 * Scope is intentionally narrow: human slash commands only, local child_process runner,
 * trusted projects only for starts, no Supacode runner, and no mutating LLM tool.
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

// Child-process + log-stream lifecycle lives in ./job-runtime.ts; these are re-exported
// because the integration suite imports them from the built bundle.
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

// Read-time job-state projection (projectState/deriveState/refineOrphanedIdentity/
// decorateStatus) lives in ./job-state.ts; imported here and used by the listing,
// status, and deletion paths. Internal (not part of the public surface).

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
// The only states a finished job's artifacts may be deleted in. `starting`/`running`
// (and read-time `orphaned`/`stale`/`unknown`) are never deletable — see classifyForDeletion.
const DELETABLE_STATES = new Set(["completed", "failed", "cancelled", "interrupted"]);

// Enumerate project-local run dirs (trusted only), yielding {jobId, runDir, status} for each
// valid, non-symlinked job dir. Shared by reconcile and prune so the trust/symlink/path
// gating and the .audit.jsonl dotfile skipping (validJobId rejects the leading dot) live in
// exactly one place. Active-session filtering and state logic stay with each caller.
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
	let reconciled = 0;
	for (const { jobId, runDir, status } of await eachProjectRunDir(ctx)) {
		if (activeJobs.has(jobId)) continue;
		const state = asString(status?.state);
		if (!state || !RECONCILABLE_STATES.has(state)) continue;
		const pid = asNumber(status?.pid);
		const live = probeProcessAlive(pid);
		// Dead pid => process gone. Alive but a different start identity => the pid was
		// reused, so our process is also gone. Both are positive evidence to terminalize;
		// an alive pid we cannot disprove (same/unknown) stays a read-time orphaned/stale.
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

function rejectInPlanMode(action: "start" | "cancel" | "delete" | "prune"): BgResponse | undefined {
	if (!planModeActive()) return undefined;
	return response(
		`Cannot /bg ${action} while plan mode is active. Approve or exit /plan first.`,
		{ action, blockedBy: "plan-mode" },
		"warning",
	);
}

function canRunInMode(ctx: ExtensionContext): boolean {
	return ctx.mode === "tui" || ctx.mode === "rpc";
}

// Status-sidecar write, stream backpressure/guarding, one-shot finalize, and process-
// group signalling live in ./job-runtime.ts (imported above + re-exported for tests).

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
	if (!canRunInMode(ctx))
		return response(
			"Cannot /bg start outside a persistent TUI/RPC session.",
			{ action: "start", blockedBy: "mode", mode: ctx.mode },
			"warning",
		);
	if (!ctx.isProjectTrusted())
		return response("Cannot /bg start in an untrusted project.", { action: "start", blockedBy: "trust" }, "warning");

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
			`Started background job ${jobId}.`,
			`Artifacts: ${runDir}`,
			`Status: /bg status ${jobId}`,
			`Logs: /bg logs ${jobId}`,
		].join("\n"),
		{ action: "start", jobId, artifactsDir: runDir, pid: child.pid },
	);
}

// Cancel a job this session does not own (persisted by another Pi process/run). The
// safety rule that the in-session path takes for granted must be earned here: only
// signal when the live pid is VERIFIED still our process (same start identity). A
// reused pid or one we cannot verify is never signaled — it is left for OS tools.
async function cancelPersistedJob(ctx: ExtensionContext, jobId: string): Promise<BgResponse> {
	const runDir = await findJobDir(ctx, jobId);
	if (!runDir)
		return response(
			`Background job ${jobId} is not active in this session; no process was killed.`,
			{ action: "cancel", jobId, active: false },
			"warning",
		);
	const status = (await readJson(path.join(runDir, "status.json"))) ?? {};
	const state = asString(status.state);
	if (!state || !RECONCILABLE_STATES.has(state)) {
		return response(
			`Background job ${jobId} has already finished (${state ?? "unknown"}); nothing to cancel.`,
			{ action: "cancel", jobId, active: false, alreadyFinished: true },
			"warning",
		);
	}
	const pid = asNumber(status.pid);
	const identity = verifyProcessIdentity(pid, asString(status.startId));
	if (identity !== "same") {
		const why =
			identity === "different"
				? `its PID ${pid} was reused by another process`
				: "its process identity could not be verified";
		return response(
			`Refusing to cancel background job ${jobId}: ${why}, so it is not safe to signal. It was started by another Pi session; use OS tools (kill -- -${pid} / taskkill) if it is still running.`,
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
			? `Sent SIGTERM to verified orphan ${jobId} (pid ${pid}) and marked it cancelled.`
			: `Marked verified orphan ${jobId} cancelled, but signaling pid ${pid} failed.`,
		{ action: "cancel", jobId, active: false, signaled, identity: "verified" },
	);
}

async function handleCancel(ctx: ExtensionContext, jobId: string): Promise<BgResponse> {
	const blocked = rejectInPlanMode("cancel");
	if (blocked) return blocked;
	const trimmed = jobId.trim();
	if (!trimmed || !validJobId(trimmed)) return response("Usage: /bg cancel <jobId>", undefined, "warning");
	const runtime = activeJobs.get(trimmed);
	if (!runtime) return await cancelPersistedJob(ctx, trimmed);
	if (isJobFinished(runtime)) {
		return response(
			`Background job ${trimmed} has already finished; nothing to cancel.`,
			{ action: "cancel", jobId: trimmed, active: false, alreadyFinished: true },
			"warning",
		);
	}
	if (runtime.status.cancelRequested) {
		return response(
			`Cancellation already requested for background job ${trimmed}.`,
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
	return response(`Cancel requested for background job ${trimmed}.`, {
		action: "cancel",
		jobId: trimmed,
		active: true,
	});
}

async function handleList(ctx: ExtensionContext): Promise<BgResponse> {
	const jobs = await listJobs(ctx);
	if (jobs.length === 0) return response("No background jobs found.", { jobs: [] });
	return response(["Background jobs:", ...jobs.map(formatJob)].join("\n"), { jobs });
}

// Single source of truth for whether a job's artifacts may be removed. Never trusts
// status.json.state as liveness: re-derives the live state via projectState and refines
// an orphaned pid by identity. Active (owned) and verified/unverifiable-alive jobs are
// never deletable; a reused pid refines to `interrupted` and is.
function classifyForDeletion(
	jobId: string,
	status: Record<string, unknown> | undefined,
): { liveState: string; deletable: boolean; reason?: string } {
	if (activeJobs.has(jobId)) return { liveState: "running", deletable: false, reason: "it is active in this session" };
	const pid = asNumber(status?.pid);
	let state: string = projectState(jobId, asString(status?.state), pid).state;
	if (state === "orphaned") state = refineOrphanedIdentity(pid, asString(status?.startId)).state;
	if (DELETABLE_STATES.has(state)) return { liveState: state, deletable: true };
	const reason =
		state === "orphaned"
			? "its process is still alive (or its identity cannot be verified)"
			: state === "stale"
				? "its liveness cannot be proven"
				: `it is not in a terminal state (${state})`;
	return { liveState: state, deletable: false, reason };
}

// Bulk-remove finished jobs. R4 implements the default dry-run preview: list deletable
// candidates (with size) and the skipped jobs with reasons, never removing anything. R5
// wires the --yes execution. classifyForDeletion is the single deletability predicate.
async function handlePrune(ctx: ExtensionContext, tail: string): Promise<BgResponse> {
	const blocked = rejectInPlanMode("prune");
	if (blocked) return blocked;
	if (!ctx.isProjectTrusted())
		return response("Cannot /bg prune in an untrusted project.", { action: "prune", blockedBy: "trust" }, "warning");
	const { yes } = parsePruneFlags(tail);
	const candidates: { jobId: string; state: string; bytes: number }[] = [];
	const skipped: { jobId: string; state: string; reason: string }[] = [];
	for (const { jobId, runDir, status } of await eachProjectRunDir(ctx)) {
		const verdict = classifyForDeletion(jobId, status);
		if (verdict.deletable) candidates.push({ jobId, state: verdict.liveState, bytes: await dirSizeBytes(runDir) });
		else skipped.push({ jobId, state: verdict.liveState, reason: verdict.reason ?? "not deletable" });
	}
	const totalBytes = candidates.reduce((sum, c) => sum + c.bytes, 0);
	if (yes) {
		// Remove each candidate via the shared removeRunDir, which re-derives deletability
		// from a fresh status read right before fs.rm (so a job revived since the scan is
		// skipped) and appends one .audit.jsonl line per removal.
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
			`Pruned ${deleted.length} of ${candidates.length} candidate job(s) (${skipped.length} skipped).`,
			...deleted.map((id) => `  deleted ${id}`),
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
		`Prune preview: ${candidates.length} deletable (${totalBytes} bytes), ${skipped.length} skipped.`,
		...candidates.map((c) => `  delete ${c.jobId} · ${c.state} · ${c.bytes}B`),
		...skipped.map((s) => `  skip   ${s.jobId} · ${s.state} · ${s.reason}`),
		candidates.length ? `Run /bg prune --yes to delete ${candidates.length} job(s).` : "Nothing to prune.",
	];
	return response(lines.join("\n"), {
		action: "prune",
		dryRun: true,
		candidates,
		skipped,
		totalBytes,
	});
}

// Delete one finished job's artifacts, gated on re-derived LIVE state (classifyForDeletion)
// so a running/active/verified-alive job is never deletable. removeRunDir enforces project
// scope + symlink safety at the edge.
async function handleDelete(ctx: ExtensionContext, jobId: string): Promise<BgResponse> {
	const blocked = rejectInPlanMode("delete");
	if (blocked) return blocked;
	if (!ctx.isProjectTrusted())
		return response(
			"Cannot /bg delete in an untrusted project.",
			{ action: "delete", blockedBy: "trust" },
			"warning",
		);
	const runDir = await resolveRunDir(ctx, jobId, "Usage: /bg delete <jobId>");
	if (typeof runDir !== "string") return runDir;
	// Write boundary: only the project-local store is mutable. A global-fallback job
	// resolves via findJobDir for reads, but delete refuses it (read-only).
	const projectRuns = path.join(getProjectBgRoot(ctx), RUNS_DIR);
	if (!path.resolve(runDir).startsWith(path.resolve(projectRuns) + path.sep)) {
		return response(
			`Background job ${jobId} lives in the global (read-only) fallback store; /bg delete only removes project-local jobs.`,
			{ action: "delete", jobId, deleted: false, scope: "global" },
			"warning",
		);
	}
	const status = (await readJson(path.join(runDir, "status.json"))) ?? {};
	const verdict = classifyForDeletion(jobId, status);
	if (!verdict.deletable) {
		return response(
			`Background job ${jobId} cannot be deleted: ${verdict.reason}.`,
			{ action: "delete", jobId, deleted: false, liveState: verdict.liveState },
			"warning",
		);
	}
	// Re-derive deletability from a fresh status read right before fs.rm (TOCTOU guard).
	const removed = await removeRunDir(
		ctx,
		jobId,
		{ verb: "delete", state: verdict.liveState },
		(reread) => classifyForDeletion(jobId, reread).deletable,
	);
	if (!removed)
		return response(`Background job not found: ${jobId}`, { action: "delete", jobId, deleted: false }, "warning");
	return response(`Background job ${jobId} deleted.`, { action: "delete", jobId, deleted: true });
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
		const refined = refineOrphanedIdentity(pid, asString(status.startId));
		if (refined.state === "interrupted") {
			status.state = "interrupted";
			delete status.hint;
			status.interruptedCause = "pid-reused";
		} else if (refined.verified) {
			status.identity = "verified";
			status.hint = `PID ${pid} is verified still running (same start identity). Stop it with kill -- -${pid} / taskkill; /bg cancel will not signal a persisted PID.`;
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
	const runDir = await resolveRunDir(ctx, jobId, "Usage: /bg logs <jobId>");
	if (typeof runDir !== "string") return runDir;
	const combined = await boundedArtifactResponse(runDir, jobId, "combined.log", "combined.log", "(empty log)");
	if (combined) return combined;
	const stdout = await readBoundedLog(path.join(runDir, "stdout.log"));
	const stderr = await readBoundedLog(path.join(runDir, "stderr.log"));
	if (stdout === undefined && stderr === undefined)
		return response(`No logs found for ${jobId}.`, { jobId, found: true, logs: false }, "warning");
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
			return response(
				"Usage: /bg preview <command> | /bg start <command> | /bg cancel <jobId> | /bg list | /bg status <jobId> | /bg logs <jobId> | /bg events <jobId> | /bg delete <jobId> | /bg prune [--yes]",
				undefined,
				"warning",
			);
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
					`Unknown /bg subcommand: ${subcommand}. Supported: preview, start, cancel, list, status, logs, events, delete, prune.`,
					undefined,
					"warning",
				);
		}
	} catch (err) {
		return response(`/bg failed: ${(err as Error).message}`, { error: (err as Error).message }, "error");
	}
}

export default function bgExtension(pi: ExtensionAPI): void {
	pi.registerCommand("bg", {
		description:
			"Background jobs: /bg preview <command> | /bg start <command> | /bg cancel <jobId> | /bg list | /bg status <jobId> | /bg logs <jobId> | /bg events <jobId> | /bg delete <jobId> | /bg prune [--yes]",
		getArgumentCompletions: (argumentPrefix: string) => {
			const items = [
				{
					value: "preview",
					label: "preview",
					description: "Dry-run (preview) a background command",
				},
				{ value: "start", label: "start", description: "Start a background job" },
				{ value: "cancel", label: "cancel", description: "Cancel an active background job" },
				{ value: "list", label: "list", description: "List background job artifacts" },
				{ value: "status", label: "status", description: "Read job status" },
				{ value: "logs", label: "logs", description: "Read bounded job logs" },
				{ value: "events", label: "events", description: "Read bounded job lifecycle events" },
				{ value: "delete", label: "delete", description: "Delete a finished job's artifacts" },
				{
					value: "prune",
					label: "prune",
					description: "Preview/prune finished job artifacts (--yes to delete)",
				},
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
