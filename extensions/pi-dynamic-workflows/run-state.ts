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

import type { WorkflowRunRecord, WorkflowRunResult, WorkflowRunState, WorkflowLogEntry, AgentMonitorModel } from "./index.js";

export function getRunElapsedMs(run: WorkflowRunRecord, state: WorkflowRunState = getRunState(run)): number {
	if (state === "running") {
		const started = new Date(run.startedAt).getTime();
		if (Number.isFinite(started)) return Date.now() - started;
	}
	return run.elapsedMs;
}

export function getRunAgentConcurrency(run: WorkflowRunRecord): number | undefined {
	return typeof run.agentConcurrency === "number" && Number.isFinite(run.agentConcurrency) ? Math.max(0, Math.floor(run.agentConcurrency)) : undefined;
}

export function getRunParallelAgents(run: WorkflowRunRecord, agents?: AgentMonitorModel[]): number {
	if (typeof run.parallelAgents === "number" && Number.isFinite(run.parallelAgents)) return Math.max(0, Math.floor(run.parallelAgents));
	if (getRunState(run) === "running" && agents) return agents.filter((agent) => agent.state === "running").length;
	return 0;
}

export function estimatePeakParallelAgents(agents: AgentMonitorModel[]): number | undefined {
	const points: Array<{ t: number; d: number }> = [];
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
	if (typeof run.peakParallelAgents === "number" && Number.isFinite(run.peakParallelAgents)) return Math.max(0, Math.floor(run.peakParallelAgents));
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
