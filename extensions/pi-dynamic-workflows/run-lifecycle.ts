/**
 * Workflow run lifecycle — background launch/resume/cancel/delete plus the run-status
 * scaffolding and shutdown abort. Sits between the runWorkflow engine and the command/tool
 * handlers in index.ts.
 *
 * Fully-deferred bidirectional cycle: this module calls runWorkflow/prepareWorkflowRun/
 * refreshActiveWorkflowStatus/resolveWorkflow + reads activeRuns from ./index.js only
 * inside bodies, and index.ts imports the lifecycle entry points back (invoked only from
 * handler bodies) and re-exports settleWithinTimeout for the shutdown test. Run records come
 * from the run-store / run-state / run-view siblings; run record types cross as import type.
 * Extracted byte-identically.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getRunDirs, readRunRecord, readRunStatus, writeJsonFile, writeRunStatus } from "./run-store.js";
import { formatParallelAgents, getRunPeakParallelAgents, getRunState, getRunStatusLabel } from "./run-state.js";
import { resolveRun, selectRunByKey } from "./run-view.js";
import { computeCodeHash, loadJournal, maxAgentArtifactNumber, maxJournalAgentId } from "./journal.js";
import { buildLimits, limitParamsFromInput } from "./config.js";
import { notify } from "./notify.js";
import {
	runWorkflow,
	prepareWorkflowRun,
	refreshActiveWorkflowStatus,
	resolveWorkflow,
	activeRuns,
	ensureDir,
	formatRunSummary,
	runWorkflowWithUi,
} from "./index.js";
import type {
	ActiveWorkflowRun,
	WorkflowRunStatus,
	WorkflowRunResult,
	WorkflowRunRecord,
	WorkflowFile,
	PreparedWorkflowRun,
	RunLimits,
	WorkflowLogEntry,
} from "./index.js";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

function initialRunStatus(
	workflow: WorkflowFile,
	prepared: PreparedWorkflowRun,
	active: boolean,
	limits?: RunLimits,
): WorkflowRunStatus {
	const now = Date.now();
	return {
		workflow: workflow.name,
		scope: workflow.scope,
		file: workflow.path,
		runId: prepared.runId,
		runDir: prepared.runDir,
		state: "running",
		background: prepared.background,
		active,
		startedAt: new Date(prepared.started).toISOString(),
		updatedAt: new Date(now).toISOString(),
		elapsedMs: now - prepared.started,
		agentCount: 0,
		...(limits
			? {
					agentConcurrency: limits.concurrency,
					maxAgents: limits.maxAgents,
					parallelAgents: 0,
					peakParallelAgents: prepared.resume?.previousPeakParallelAgents ?? 0,
				}
			: {}),
		logs: [],
	};
}

export function formatBackgroundStart(status: WorkflowRunStatus): string {
	return [
		`Started background workflow: ${status.workflow}`,
		`Run: ${status.runId}`,
		`Parallel agents: ${formatParallelAgents(status)}`,
		`Status: ${path.join(status.runDir, "status.json")}`,
		`Artifacts: ${status.runDir}`,
		`View: dynamic_workflow action=view name=${status.runId}`,
		`Cancel: dynamic_workflow action=cancel name=${status.runId}`,
	].join("\n");
}

function makeWorkflowWakePrompt(result: WorkflowRunResult): string {
	const state = getRunStatusLabel(result);
	return `Background workflow finished.

Workflow: ${result.workflow}
Run: ${result.runId}
State: ${state}
Artifacts: ${result.runDir}

Please inspect the run with dynamic_workflow action=view name=${result.runId}, read relevant artifacts if needed, and continue the user's task. If the workflow failed, went stale, or produced risks, explain that clearly and propose the next action.`;
}

function wakeAgentForWorkflowResult(pi: ExtensionAPI, ctx: ExtensionContext, result: WorkflowRunResult): void {
	if (ctx.mode !== "tui" && ctx.mode !== "rpc") return;
	if (getRunState(result) === "cancelled") return;
	const prompt = makeWorkflowWakePrompt(result);
	if (ctx.isIdle()) pi.sendUserMessage(prompt);
	else pi.sendUserMessage(prompt, { deliverAs: "followUp" });
}

function canLaunchWorkflowInBackground(ctx: ExtensionContext): boolean {
	return ctx.mode === "tui" || ctx.mode === "rpc";
}

export function shouldLaunchWorkflowInBackground(ctx: ExtensionContext): boolean {
	// Project preference: every workflow launched from a persistent session runs
	// in background so the dashboard remains the control plane and completion can
	// wake the agent. Print/json modes have no live session to keep the run alive.
	return canLaunchWorkflowInBackground(ctx);
}

export async function startWorkflowBackground(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	workflow: WorkflowFile,
	input: unknown,
	limits: RunLimits,
	preparedRun?: PreparedWorkflowRun,
): Promise<WorkflowRunStatus> {
	if (!canLaunchWorkflowInBackground(ctx)) {
		throw new Error(
			"Background workflow runs require a persistent TUI/RPC session. In print/json mode, action=run falls back to foreground because there is no live session to keep a background run alive.",
		);
	}
	// For resume, preparedRun reuses the existing runDir/runId in place.
	const prepared = preparedRun ?? (await prepareWorkflowRun(ctx, workflow.name, true));
	const controller = new AbortController();
	const active: ActiveWorkflowRun = {
		runId: prepared.runId,
		runDir: prepared.runDir,
		started: prepared.started,
		workflow,
		controller,
	};
	activeRuns.set(prepared.runId, active);
	const status = initialRunStatus(workflow, prepared, true, limits);
	await writeRunStatus(status);
	refreshActiveWorkflowStatus(ctx);

	const promise = runWorkflow(pi, ctx, workflow, input, limits, controller.signal, undefined, prepared)
		.then((result) => {
			const resultState = getRunState(result);
			const type = resultState === "completed" ? "info" : resultState === "cancelled" ? "warning" : "error";
			notify(
				ctx,
				`Background workflow ${getRunStatusLabel(result)}: ${workflow.name}\nRun: ${result.runId}\nArtifacts: ${result.runDir}`,
				type,
			);
			wakeAgentForWorkflowResult(pi, ctx, result);
			return result;
		})
		.catch(async (err) => {
			const now = Date.now();
			const error = err instanceof Error ? err.stack || err.message : String(err);
			const result: WorkflowRunResult = {
				workflow: workflow.name,
				scope: workflow.scope,
				file: workflow.path,
				runId: prepared.runId,
				runDir: prepared.runDir,
				ok: false,
				state: "failed",
				background: true,
				startedAt: new Date(prepared.started).toISOString(),
				endedAt: new Date(now).toISOString(),
				elapsedMs: now - prepared.started,
				agentCount: 0,
				agentConcurrency: limits.concurrency,
				maxAgents: limits.maxAgents,
				parallelAgents: 0,
				peakParallelAgents: 0,
				logs: [],
				error,
			};
			await writeJsonFile(path.join(prepared.runDir, "result.json"), result);
			await writeRunStatus({
				...initialRunStatus(workflow, prepared, false, limits),
				state: "failed",
				endedAt: new Date(now).toISOString(),
				updatedAt: new Date(now).toISOString(),
				elapsedMs: now - prepared.started,
				error,
			});
			await fs.writeFile(path.join(prepared.runDir, "summary.md"), formatRunSummary(result), "utf8");
			notify(
				ctx,
				`Background workflow failed to run: ${workflow.name}\nRun: ${prepared.runId}\nError: ${error}`,
				"error",
			);
			wakeAgentForWorkflowResult(pi, ctx, result);
			return result;
		})
		.finally(() => {
			activeRuns.delete(prepared.runId);
			refreshActiveWorkflowStatus(ctx);
		});
	active.promise = promise;
	void promise;
	return status;
}

// Resume an interrupted run in place (same runDir/runId), reusing the journal so
// already-completed subagent/bash calls are not re-executed.
export async function resumeWorkflow(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	idOrLatest: string | undefined,
	opts: { background?: boolean; force?: boolean } = {},
	signal?: AbortSignal,
	onProgress?: (logs: WorkflowLogEntry[], status?: WorkflowRunStatus) => void,
): Promise<WorkflowRunRecord> {
	const record = await resolveRun(ctx, idOrLatest);
	if (activeRuns.has(record.runId)) {
		throw new Error(`Workflow run is already active: ${record.runId}. Cancel it first or wait for it to finish.`);
	}
	const state = getRunState(record);
	const resumable =
		state === "stale" ||
		state === "failed" ||
		state === "cancelled" ||
		(opts.force === true && state === "completed");
	if (!resumable) {
		if (state === "running")
			throw new Error(`Workflow run ${record.runId} is still running. Cancel it before resuming.`);
		if (state === "completed")
			throw new Error(`Workflow run ${record.runId} already completed. Use force:true to resume it anyway.`);
		throw new Error(`Workflow run ${record.runId} cannot be resumed (state: ${String(state)}).`);
	}

	const workflow = await resolveWorkflow(ctx, record.workflow, record.scope);
	const code = await fs.readFile(workflow.path, "utf8");
	const codeHash = computeCodeHash(code);
	const journal = await loadJournal(record.runDir);
	// Start agentCount above the highest id already used (journaled OR on disk),
	// so freshly re-run subagents can never overwrite an existing agents/NNNN
	// artifact, even when the journal is non-contiguous or has {cache:false} gaps.
	const baseAgentCount = Math.max(maxJournalAgentId(journal), await maxAgentArtifactNumber(record.runDir));

	let input: unknown = {};
	try {
		input = JSON.parse(await fs.readFile(path.join(record.runDir, "input.json"), "utf8"));
	} catch {
		input = {};
	}
	const limits = buildLimits(limitParamsFromInput(input));
	const resumeInBackground = shouldLaunchWorkflowInBackground(ctx);

	const prepared: PreparedWorkflowRun = {
		started: Number.isFinite(new Date(record.startedAt).getTime())
			? new Date(record.startedAt).getTime()
			: Date.now(),
		runId: record.runId,
		runDir: record.runDir,
		background: resumeInBackground,
		resume: {
			journal,
			baseAgentCount,
			codeHash,
			resumedFrom: record.runId,
			previousPeakParallelAgents: getRunPeakParallelAgents(record) ?? 0,
		},
	};
	await ensureDir(path.join(record.runDir, "agents"));
	// Remove the stale result.json from the prior (failed/cancelled/completed)
	// run. readRunRecord reads result.json before status.json, so leaving it in
	// place would mask the live running status for the duration of the resume
	// (runs/view/dashboard would show the old terminal state). runWorkflow
	// rewrites result.json when the resumed run finishes.
	await fs.rm(path.join(record.runDir, "result.json"), { force: true }).catch(() => {});

	const previousHash = record.codeHash;
	if (previousHash && previousHash !== codeHash) {
		notify(
			ctx,
			`Note: workflow code changed since run ${record.runId} (codeHash ${previousHash.slice(0, 12)} -> ${codeHash.slice(0, 12)}). Calls whose arguments changed will be re-executed (cache miss); unchanged calls stay cached.`,
			"warning",
		);
	}

	if (resumeInBackground) {
		// Returns a WorkflowRunStatus (the run keeps executing in the background).
		return await startWorkflowBackground(pi, ctx, workflow, input, limits, prepared);
	}

	// Print/json fallback: returns a WorkflowRunResult because background cannot stay alive.
	return await runWorkflowWithUi(pi, ctx, workflow, input, limits, signal, onProgress, prepared);
}

function resolveActiveRun(id: string | undefined): ActiveWorkflowRun | undefined {
	const runs = [...activeRuns.values()].sort((a, b) => b.started - a.started);
	const key = id?.trim();
	if (!key || key === "latest") return runs[0];
	return (
		activeRuns.get(key) ??
		selectRunByKey(
			runs,
			key,
			(run) => run.runId,
			(run) => run.workflow.name,
		)
	);
}

export async function cancelWorkflowRun(ctx: ExtensionContext, id: string | undefined): Promise<string> {
	const active = resolveActiveRun(id);
	if (!active) {
		if (id?.trim()) {
			try {
				const run = await resolveRun(ctx, id);
				return `Workflow run is not active (${getRunStatusLabel(run)}): ${run.runId}`;
			} catch {
				// Fall through to a clearer active-run message.
			}
		}
		throw new Error("No active background workflow run found.");
	}
	active.controller.abort("Workflow cancelled.");
	const existing = await readRunStatus(active.runDir);
	if (existing) {
		const now = Date.now();
		await writeRunStatus({
			...existing,
			state: "cancelled",
			active: false,
			updatedAt: new Date(now).toISOString(),
			endedAt: new Date(now).toISOString(),
			elapsedMs: now - active.started,
			error: "Workflow cancelled.",
		});
	}
	return `Cancellation requested for background workflow run: ${active.runId}`;
}

async function resolveRunForDeletion(
	ctx: ExtensionContext,
	id: string | undefined,
): Promise<{ run: WorkflowRunRecord; runDir: string }> {
	const dirs = await getRunDirs(ctx);
	const records: { run: WorkflowRunRecord; runDir: string }[] = [];
	for (const runDir of dirs) {
		const run = await readRunRecord(runDir);
		if (run) records.push({ run, runDir });
	}
	if (records.length === 0) throw new Error("No workflow runs found.");
	const key = id?.trim() || "latest";
	if (key === "latest") return records[0];
	const found = selectRunByKey(
		records,
		key,
		({ run }) => run.runId,
		({ run }) => run.workflow,
	);
	if (!found) throw new Error(`Workflow run not found: ${key}`);
	return found;
}

export async function deleteWorkflowRun(ctx: ExtensionContext, id: string | undefined): Promise<string> {
	const { run, runDir } = await resolveRunForDeletion(ctx, id);
	if (activeRuns.has(run.runId))
		throw new Error(`Workflow run is active; cancel it before deleting artifacts: ${run.runId}`);
	await fs.rm(runDir, { recursive: true, force: false });
	return `Deleted workflow run artifacts: ${run.runId}\nDirectory: ${runDir}`;
}

// Race a promise against a timeout. The timeout timer is always cleared afterwards so a
// fast-settling promise can't leave a pending timer keeping the event loop alive (e.g. at
// session shutdown).
export async function settleWithinTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const guard = new Promise<void>((resolve) => {
		timer = setTimeout(resolve, timeoutMs);
	});
	try {
		await Promise.race([work.then(() => undefined), guard]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

export async function abortActiveWorkflowRuns(reason: string): Promise<void> {
	const promises = [...activeRuns.values()]
		.map((run) => {
			run.controller.abort(reason);
			return run.promise;
		})
		.filter((promise): promise is Promise<WorkflowRunResult> => promise !== undefined);
	if (promises.length === 0) return;
	await settleWithinTimeout(Promise.allSettled(promises), 3000);
	activeRuns.clear();
}
