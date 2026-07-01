/**
 * Shared run-state model kernel for the dynamic-workflows monitor/runner.
 *
 * Pure, side-effect-free derivations over a WorkflowRunRecord (state, status
 * label/icon, elapsed time, parallel-agent counts/peak). Lives here so BOTH
 * index.ts (runner/tool path) and the monitor TUI can use them without the TUI
 * having to import runtime values from index.ts (which would create an ESM
 * cycle). The only dependency back on index.ts is TYPE-only (`import type`),
 * erased at build time, so index.ts -> run-state.js is a one-way runtime edge.
 *
 * Bodies moved verbatim from index.ts (behavior-preserving).
 */

import type {
	AgentMonitorModel,
	WorkflowLogEntry,
	WorkflowRunRecord,
	WorkflowRunResult,
	WorkflowRunState,
} from "./index.js";

export function getRunElapsedMs(run: WorkflowRunRecord, state: WorkflowRunState = getRunState(run)): number {
	if (state === "running") {
		const started = new Date(run.startedAt).getTime();
		if (Number.isFinite(started)) return Date.now() - started;
	}
	return run.elapsedMs;
}

export function getRunAgentConcurrency(run: WorkflowRunRecord): number | undefined {
	return typeof run.agentConcurrency === "number" && Number.isFinite(run.agentConcurrency)
		? Math.max(0, Math.floor(run.agentConcurrency))
		: undefined;
}

export function getRunParallelAgents(run: WorkflowRunRecord, agents?: AgentMonitorModel[]): number {
	if (typeof run.parallelAgents === "number" && Number.isFinite(run.parallelAgents))
		return Math.max(0, Math.floor(run.parallelAgents));
	if (getRunState(run) === "running" && agents) return agents.filter((agent) => agent.state === "running").length;
	return 0;
}

export function estimatePeakParallelAgents(agents: AgentMonitorModel[]): number | undefined {
	const points: { t: number; d: number }[] = [];
	for (const agent of agents) {
		if (agent.state === "cached") continue;
		const started = agent.startedAt ? new Date(agent.startedAt).getTime() : Number.NaN;
		if (!Number.isFinite(started)) continue;
		points.push({ t: started, d: 1 });
		const ended = agent.endedAt ? new Date(agent.endedAt).getTime() : Number.NaN;
		if (Number.isFinite(ended)) points.push({ t: ended, d: -1 });
	}
	if (points.length === 0) return undefined;
	// On a timestamp tie, apply ends (-1) before starts (+1) so a hand-off (one agent ends exactly
	// when the next starts) is not double-counted as concurrent.
	points.sort((a, b) => a.t - b.t || a.d - b.d);
	let current = 0;
	let peak = 0;
	for (const point of points) {
		current = Math.max(0, current + point.d);
		peak = Math.max(peak, current);
	}
	return peak;
}

export function getRunPeakParallelAgents(run: WorkflowRunRecord, agents?: AgentMonitorModel[]): number | undefined {
	if (typeof run.peakParallelAgents === "number" && Number.isFinite(run.peakParallelAgents))
		return Math.max(0, Math.floor(run.peakParallelAgents));
	return agents ? estimatePeakParallelAgents(agents) : undefined;
}

export function formatParallelAgents(run: WorkflowRunRecord, agents?: AgentMonitorModel[]): string {
	const current = getRunParallelAgents(run, agents);
	const limit = getRunAgentConcurrency(run);
	const peak = getRunPeakParallelAgents(run, agents);
	const currentText = limit && limit > 0 ? `${current}/${limit} running` : `${current} running`;
	const peakText = peak === undefined ? "" : ` • peak:${peak}`;
	return `${currentText}${peakText}`;
}

export function formatParallelAgentsCompact(run: WorkflowRunRecord, agents?: AgentMonitorModel[]): string {
	const current = getRunParallelAgents(run, agents);
	const limit = getRunAgentConcurrency(run);
	const peak = getRunPeakParallelAgents(run, agents);
	if (getRunState(run) === "running") return limit && limit > 0 ? `${current}/${limit}` : String(current);
	return peak === undefined ? "-" : `peak:${peak}`;
}

export function isRunResult(run: WorkflowRunRecord): run is WorkflowRunResult {
	return "ok" in run;
}

export function getRunState(run: WorkflowRunRecord): WorkflowRunState {
	if (!isRunResult(run)) return run.state;
	if (run.state) return run.state;
	if (run.ok) return "completed";
	return run.error?.toLowerCase().includes("cancel") ? "cancelled" : "failed";
}

export function getRunLogs(run: WorkflowRunRecord): WorkflowLogEntry[] {
	return run.logs ?? [];
}

// A run can be resumed in place when it was interrupted (stale) or ended
// without completing (failed/cancelled). Completed runs need force.
export function isResumableState(state: WorkflowRunState): boolean {
	return state === "stale" || state === "failed" || state === "cancelled";
}

// A run is terminal (safe to delete) when it is no longer running: completed, failed,
// cancelled, or stale. This is the complement of "running".
export function isTerminalRunState(state: WorkflowRunState): boolean {
	return state !== "running";
}

// Pure selection policy for `/workflow cleanup runs`. Returns the run records that are safe
// to delete: only TERMINAL runs (never running), never a run tracked as active in-memory
// (activeIds), optionally filtered to a set of states, and always retaining the `keep`
// most-recent runs (by startedAt desc) so a bulk cleanup can't wipe the freshest history.
// The IO wrapper (run-lifecycle.ts, cleanupWorkflowRuns) does the actual fs.rm.
export function selectRunsForCleanup(
	runs: WorkflowRunRecord[],
	opts: { keep?: number; states?: WorkflowRunState[]; activeIds: Set<string> },
): WorkflowRunRecord[] {
	const keep = Math.max(0, Math.floor(opts.keep ?? 0));
	const stateFilter = opts.states ? new Set(opts.states) : undefined;
	const candidates = runs
		.filter((run) => {
			const state = getRunState(run);
			if (!isTerminalRunState(state)) return false;
			if (opts.activeIds.has(run.runId)) return false;
			if (stateFilter && !stateFilter.has(state)) return false;
			return true;
		})
		.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
	return candidates.slice(keep);
}

export function getRunCachedCalls(run: WorkflowRunRecord): number {
	return typeof run.cachedCalls === "number" ? run.cachedCalls : 0;
}

export function getRunStatusLabel(run: WorkflowRunRecord): string {
	const state = getRunState(run);
	if (state === "completed") return "completed";
	if (state === "running") return "running";
	if (state === "cancelled") return "cancelled";
	if (state === "stale") return "stale";
	return "failed";
}

export function getRunStatusIcon(run: WorkflowRunRecord): string {
	const state = getRunState(run);
	if (state === "completed") return "✓";
	if (state === "running") return "▶";
	if (state === "cancelled") return "■";
	if (state === "stale") return "?";
	return "✗";
}
