/**
 * Fase de finalización de runWorkflow: arma el WorkflowRunResult final y persiste
 * result.json / status / summary.md / métricas de focus. Best-effort para métricas
 * (nunca cambia el outcome del run). Extraído de engine.ts.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { formatRunSummary } from "../lib/run-summary.js";
import { type AgentFocusMetrics, aggregateRunFocusMetrics, formatFocusMetricsMarkdown } from "../observe/index.js";
import type {
	RunLimits,
	WorkflowDefinition,
	WorkflowLogEntry,
	WorkflowResultIntegrity,
	WorkflowRunResult,
	WorkflowRunState,
	WorkflowRunStatus,
} from "../types.js";
import { writeJsonFile, writeRunStatus } from "./store.js";

export type FinalizeWorkflowRunDeps = {
	resultIntegrity: () => WorkflowResultIntegrity | undefined;
	makeStatus: (statusState?: WorkflowRunState, now?: number) => WorkflowRunStatus;
};

export type FinalizeWorkflowRunParams = {
	workflowDefinition: WorkflowDefinition;
	runId: string;
	runDir: string;
	background: boolean;
	started: number;
	runLimits: Readonly<RunLimits>;
	agentCount: number;
	parallelAgents: number;
	peakParallelAgents: number;
	logs: WorkflowLogEntry[];
	state: WorkflowRunState;
	output: unknown;
	error: string | undefined;
	codeHash: string;
	cachedCalls: number;
	resumedFrom: string | undefined;
	focusByAgent: AgentFocusMetrics[];
};

export async function finalizeWorkflowRun(
	deps: FinalizeWorkflowRunDeps,
	params: FinalizeWorkflowRunParams,
): Promise<WorkflowRunResult> {
	const { resultIntegrity, makeStatus } = deps;
	const {
		workflowDefinition,
		runId,
		runDir,
		background,
		started,
		runLimits,
		agentCount,
		parallelAgents,
		peakParallelAgents,
		logs,
		state,
		output,
		error,
		codeHash,
		cachedCalls,
		resumedFrom,
		focusByAgent,
	} = params;

	const ended = Date.now();
	const resultState: Exclude<WorkflowRunState, "running" | "stale"> =
		state === "completed" || state === "cancelled" ? state : "failed";
	const resultIntegritySnapshot = resultIntegrity();
	const result: WorkflowRunResult = {
		workflow: workflowDefinition.name,
		scope: workflowDefinition.scope,
		file: workflowDefinition.path,
		runId,
		runDir,
		ok: resultState === "completed",
		state: resultState,
		background,
		startedAt: new Date(started).toISOString(),
		endedAt: new Date(ended).toISOString(),
		elapsedMs: ended - started,
		agentCount,
		agentConcurrency: runLimits.concurrency,
		maxAgents: runLimits.maxAgents,
		parallelAgents,
		peakParallelAgents,
		logs,
		...(output === undefined ? {} : { output }),
		...(error === undefined ? {} : { error }),
		...(resultIntegritySnapshot ? { integrity: resultIntegritySnapshot } : {}),
		...(codeHash ? { codeHash } : {}),
		...(cachedCalls ? { cachedCalls } : {}),
		...(resumedFrom ? { resumedFrom } : {}),
	};
	await writeJsonFile(path.join(runDir, "result.json"), result);
	await writeRunStatus({
		...makeStatus(resultState, ended),
		...(output === undefined ? {} : { output }),
		...(error === undefined ? {} : { error }),
	});
	await fs.writeFile(path.join(runDir, "summary.md"), formatRunSummary(result), "utf8");
	// Focus observability artifacts (research §4): aggregate per-agent metrics into a
	// machine-readable metrics.json + a human-readable metrics.md. Fully fail-safe so a
	// metrics write can never change the run's outcome.
	try {
		const focus = aggregateRunFocusMetrics(focusByAgent);
		// writeJsonFile/fs.writeFile are abort-agnostic, so these land even though the run
		// signal is already aborted by the finally above.
		await writeJsonFile(path.join(runDir, "metrics.json"), { ...focus, cachedCalls, agentCount });
		await fs.writeFile(path.join(runDir, "metrics.md"), formatFocusMetricsMarkdown(focus, { cachedCalls }), "utf8");
	} catch {
		/* metrics are best-effort observability; never fail the run on them */
	}
	return result;
}
