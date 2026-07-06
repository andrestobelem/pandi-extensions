/**
 * Capa de datos del dashboard — el lado de lectura que colecta actividad/agentes de runs y deriva los
 * modelos de workflow monitor que renderiza la UI del dashboard (workflow-dashboard.ts) y que abre la
 * orquestación. Construye objetos de modelo planos desde estado/logs/eventos de run; los contratos de
 * modelo cruzan desde types.ts como import type.
 */
import { existsSync } from "node:fs";
import { readRunEvents, readRunLogEvents } from "./event-parser.js";
import type { WorkflowPattern } from "./pattern-scaffolds.js";
import type { PiSessionModel } from "./pi-session.js";
import { workflowProgress } from "./presentation.js";
import {
	getRunAgentConcurrency,
	getRunElapsedMs,
	getRunLogs,
	getRunParallelAgents,
	getRunPeakParallelAgents,
	getRunState,
} from "./run-state.js";
import { canCancelRun, isActiveRunRecord } from "./run-status-ui.js";
import { listRunFiles } from "./run-view.js";
import { JOURNAL_FILE } from "./runtime-constants.js";
import type {
	AgentMonitorModel,
	WorkflowDefinition,
	WorkflowLogEntry,
	WorkflowRunRecord,
	WorkflowRunState,
} from "./types.js";

export interface WorkflowDashboardResult {
	type:
		| "agent"
		| "graph"
		| "run"
		| "view"
		| "cancel"
		| "rerun"
		| "deleteWorkflow"
		| "deleteRun"
		| "cleanup"
		| "newPattern"
		| "switchSession";
	workflow?: WorkflowDefinition;
	run?: WorkflowRunRecord;
	agent?: AgentMonitorModel;
	pattern?: WorkflowPattern;
	session?: PiSessionModel;
	cleanupTarget?: "sessions" | "runs";
}

export interface WorkflowAgentEntry {
	run: WorkflowRunRecord;
	agent: AgentMonitorModel;
}

export interface WorkflowActivityEntry {
	time: string;
	workflow: string;
	runId: string;
	state: WorkflowRunState;
	message: string;
	details?: unknown;
}

export async function collectWorkflowActivity(
	runs: WorkflowRunRecord[],
	maxRuns = 12,
	maxEntries = 80,
): Promise<WorkflowActivityEntry[]> {
	const entries: WorkflowActivityEntry[] = [];
	for (const run of runs.slice(0, maxRuns)) {
		const logs = getRunLogs(run).length > 0 ? getRunLogs(run) : await readRunLogEvents(run.runDir);
		for (const logEntry of logs.slice(-20)) {
			entries.push({
				time: logEntry.time,
				workflow: run.workflow,
				runId: run.runId,
				state: getRunState(run),
				message: logEntry.message,
				...(logEntry.details === undefined ? {} : { details: logEntry.details }),
			});
		}
	}
	return entries.sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime()).slice(0, maxEntries);
}

export async function collectWorkflowAgents(runs: WorkflowRunRecord[]): Promise<WorkflowAgentEntry[]> {
	const entries: WorkflowAgentEntry[] = [];
	const runOrder = new Map(runs.map((run, index) => [run.runId, index]));
	for (const run of runs) {
		const { agents } = await readRunEvents(run.runDir);
		for (const agent of agents) entries.push({ run, agent });
	}
	return entries.sort((a, b) => {
		const byRun = (runOrder.get(a.run.runId) ?? 0) - (runOrder.get(b.run.runId) ?? 0);
		if (byRun !== 0) return byRun;
		return a.agent.id - b.agent.id;
	});
}

export interface WorkflowMonitorModel {
	run: WorkflowRunRecord;
	workflow: string;
	runId: string;
	state: WorkflowRunState;
	active: boolean;
	stale: boolean;
	elapsedMs: number;
	agentsStarted: number;
	agentsDone: number;
	parallelAgents: number;
	peakParallelAgents?: number;
	agentConcurrency?: number;
	bashDone: number;
	artifactCount: number;
	agents: AgentMonitorModel[];
	lastLog?: WorkflowLogEntry;
	runDir: string;
	priority: "active" | "latest";
	canCancel: boolean;
	canRerun: boolean;
}

// Exportado para el pin de run-report-adapters: el reporte generado es salida derivada,
// nunca un artifact de run, así que escribir report.html no debe cambiar el conteo de artifacts.
export async function countRunArtifacts(runDir: string): Promise<number> {
	try {
		const { files } = await listRunFiles(runDir, 200);
		const bookkeeping = new Set([
			"status.json",
			"result.json",
			"input.json",
			"events.jsonl",
			JOURNAL_FILE,
			"summary.md",
			"report.html",
		]);
		return files.filter((file) => !bookkeeping.has(file)).length;
	} catch {
		return 0;
	}
}

export function canRerunRun(run: WorkflowRunRecord): boolean {
	return getRunState(run) !== "running" && !!run.file && existsSync(run.file);
}

async function deriveWorkflowMonitor(
	run: WorkflowRunRecord,
	priority: "active" | "latest",
): Promise<WorkflowMonitorModel> {
	const state = getRunState(run);
	const parsedEvents = await readRunEvents(run.runDir);
	const logs = getRunLogs(run).length > 0 ? getRunLogs(run) : parsedEvents.logs;
	const { agentsStarted, agentsDone, bashDone } = workflowProgress(logs);
	const active = isActiveRunRecord(run);
	const lastLog = logs.slice(-1)[0];
	const peakParallelAgents = getRunPeakParallelAgents(run, parsedEvents.agents);
	return {
		run,
		workflow: run.workflow,
		runId: run.runId,
		state,
		active,
		stale: state === "stale" || (state === "running" && !active),
		elapsedMs: getRunElapsedMs(run, state),
		agentsStarted: Math.max(agentsStarted, run.agentCount, parsedEvents.agents.length),
		agentsDone: Math.max(
			agentsDone,
			parsedEvents.agents.filter(
				(agent) => agent.state === "completed" || agent.state === "failed" || agent.state === "cached",
			).length,
		),
		parallelAgents: getRunParallelAgents(run, parsedEvents.agents),
		...(peakParallelAgents === undefined ? {} : { peakParallelAgents }),
		...(getRunAgentConcurrency(run) === undefined ? {} : { agentConcurrency: getRunAgentConcurrency(run) }),
		bashDone,
		artifactCount: await countRunArtifacts(run.runDir),
		agents: parsedEvents.agents,
		...(lastLog ? { lastLog } : {}),
		runDir: run.runDir,
		priority,
		canCancel: canCancelRun(run),
		canRerun: canRerunRun(run),
	};
}

export async function deriveWorkflowMonitorModels(runs: WorkflowRunRecord[]): Promise<WorkflowMonitorModel[]> {
	// Mostrá TODOS los runs activos (el encabezado anuncia "▶ N active"); caé al
	// run más reciente solo cuando nada está activo. El Monitor permite cambiar el foco.
	const actives = runs.filter((run) => isActiveRunRecord(run));
	if (actives.length > 0) return Promise.all(actives.map((run) => deriveWorkflowMonitor(run, "active")));
	const latest = runs[0];
	if (!latest) return [];
	return [await deriveWorkflowMonitor(latest, "latest")];
}
