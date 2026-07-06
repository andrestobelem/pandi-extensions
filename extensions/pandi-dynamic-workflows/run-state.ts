/**
 * Núcleo compartido del modelo de estado de runs para el monitor/runner de dynamic-workflows.
 *
 * Derivaciones puras y sin efectos sobre un WorkflowRunRecord (estado, etiqueta/icono
 * de status, tiempo transcurrido, conteos/pico de agentes paralelos). Vive acá para que TANTO
 * index.ts (ruta runner/tool) como la TUI del monitor puedan usarlas sin que la TUI
 * tenga que importar valores runtime desde index.ts (lo que crearía un ciclo ESM).
 * Los contratos cruzan desde types.ts como import type, así que index.ts -> run-state.js
 * es una arista runtime unidireccional.
 *
 * Cuerpos movidos textualmente desde index.ts (preserva comportamiento).
 */

import type {
	AgentMonitorModel,
	WorkflowLogEntry,
	WorkflowRunRecord,
	WorkflowRunResult,
	WorkflowRunState,
} from "./types.js";

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
	// Si hay empate de timestamp, aplicá finales (-1) antes que inicios (+1) para que un relevo
	// (un agente termina exactamente cuando empieza el siguiente) no cuente doble como concurrencia.
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

// Un run puede reanudarse in place cuando fue interrumpido (stale) o terminó
// sin completarse (failed/cancelled). Los runs completed necesitan force.
export function isResumableState(state: WorkflowRunState): boolean {
	return state === "stale" || state === "failed" || state === "cancelled";
}

// Un run es terminal (seguro de borrar) cuando ya no está running: completed, failed,
// cancelled o stale. Es el complemento de "running".
export function isTerminalRunState(state: WorkflowRunState): boolean {
	return state !== "running";
}

// Política pura de selección para `/workflow cleanup runs`. Devuelve los registros de run que son seguros
// de borrar: solo runs TERMINAL (nunca running), nunca un run rastreado como activo en memoria
// (activeIds), opcionalmente filtrado por un conjunto de estados, y reteniendo siempre los `keep`
// runs más recientes (por startedAt desc) para que una limpieza masiva no borre el historial más fresco.
// El wrapper de IO (run-lifecycle.ts, cleanupWorkflowRuns) hace el fs.rm real.
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
