/**
 * Navegación de listas por tab del dashboard — specs compartidos fuera de la clase.
 */
import { WORKFLOW_PATTERN_CATALOG } from "../lib/pattern-catalog.js";
import type { PiSessionModel } from "../pi-session.js";
import type { AgentMonitorModel, WorkflowDefinition, WorkflowRunRecord } from "../types.js";
import type { WorkflowActivityEntry, WorkflowAgentEntry, WorkflowMonitorModel } from "./collectors.js";
import type { WorkflowDashboardTab } from "./dashboard-selection.js";

/** Navegación de lista por tab: longitud + índice activo (get/set). */
export interface TabNavSpec {
	length: () => number;
	getIndex: () => number;
	setIndex: (value: number) => void;
}

export type DashboardNavHost = {
	tab: WorkflowDashboardTab;
	workflows: WorkflowDefinition[];
	runs: WorkflowRunRecord[];
	activity: WorkflowActivityEntry[];
	piSessions: PiSessionModel[];
	agentEntries: WorkflowAgentEntry[];
	workflowIndex: number;
	runIndex: number;
	activityIndex: number;
	sessionIndex: number;
	agentIndex: number;
	monitorAgentIndex: number;
	patternIndex: number;
	selectedMonitor: () => WorkflowMonitorModel | undefined;
	setWorkflowIndex: (value: number) => void;
	setRunIndex: (value: number) => void;
	setActivityIndex: (value: number) => void;
	setSessionIndex: (value: number) => void;
	setAgentIndex: (value: number) => void;
	setMonitorAgentIndex: (value: number) => void;
	setPatternIndex: (value: number) => void;
};

export function createTabNavSpecs(host: DashboardNavHost): Record<WorkflowDashboardTab, TabNavSpec> {
	return {
		monitor: {
			length: () => host.selectedMonitor()?.agents.length ?? 0,
			getIndex: () => host.monitorAgentIndex,
			setIndex: (value) => {
				host.setMonitorAgentIndex(value);
			},
		},
		agents: {
			length: () => host.agentEntries.length,
			getIndex: () => host.agentIndex,
			setIndex: (value) => {
				host.setAgentIndex(value);
			},
		},
		workflows: {
			length: () => host.workflows.length,
			getIndex: () => host.workflowIndex,
			setIndex: (value) => {
				host.setWorkflowIndex(value);
			},
		},
		patterns: {
			length: () => WORKFLOW_PATTERN_CATALOG.length,
			getIndex: () => host.patternIndex,
			setIndex: (value) => {
				host.setPatternIndex(value);
			},
		},
		sessions: {
			length: () => host.piSessions.length,
			getIndex: () => host.sessionIndex,
			setIndex: (value) => {
				host.setSessionIndex(value);
			},
		},
		runs: {
			length: () => host.runs.length,
			getIndex: () => host.runIndex,
			setIndex: (value) => {
				host.setRunIndex(value);
			},
		},
		activity: {
			length: () => host.activity.length,
			getIndex: () => host.activityIndex,
			setIndex: (value) => {
				host.setActivityIndex(value);
			},
		},
	};
}

export function activeTabNav(host: DashboardNavHost): TabNavSpec {
	return createTabNavSpecs(host)[host.tab];
}

export function selectedAgentEntry(host: DashboardNavHost): WorkflowAgentEntry | undefined {
	return host.agentEntries[host.agentIndex];
}

export function selectedAgent(host: DashboardNavHost, tab: WorkflowDashboardTab): AgentMonitorModel | undefined {
	if (tab === "agents") return selectedAgentEntry(host)?.agent;
	return host.selectedMonitor()?.agents[host.monitorAgentIndex];
}

export function selectedRun(host: DashboardNavHost, tab: WorkflowDashboardTab): WorkflowRunRecord | undefined {
	if (tab === "monitor") return host.selectedMonitor()?.run;
	if (tab === "agents") return selectedAgentEntry(host)?.run;
	if (tab === "runs") return host.runs[host.runIndex];
	if (tab === "activity") {
		const entry = host.activity[host.activityIndex];
		return entry ? host.runs.find((candidate) => candidate.runId === entry.runId) : undefined;
	}
	return undefined;
}
