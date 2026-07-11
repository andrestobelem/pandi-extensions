/**
 * Render del cuerpo del dashboard por tab — delegación pura a las view functions.
 */
import type { PiSessionModel } from "../pi-session.js";
import type { AgentMonitorModel, WorkflowDefinition, WorkflowRunRecord } from "../types.js";
import type { WorkflowActivityEntry, WorkflowAgentEntry, WorkflowMonitorModel } from "./collectors.js";
import type { WorkflowDashboardTab } from "./dashboard-selection.js";
import { renderAgents as renderAgentsView, renderMonitor as renderMonitorView } from "./monitor.js";
import {
	renderActivityView,
	renderPatternsView,
	renderRunsView,
	renderSessionsView,
	renderWorkflowsView,
} from "./views.js";

export type DashboardThemeFns = {
	line: (s: string) => string;
	accent: (s: string) => string;
	muted: (s: string) => string;
	success: (s: string) => string;
	error: (s: string) => string;
	warning: (s: string) => string;
	dim: (s: string) => string;
};

export type DashboardRenderHost = {
	tab: WorkflowDashboardTab;
	workflows: WorkflowDefinition[];
	runs: WorkflowRunRecord[];
	activity: WorkflowActivityEntry[];
	piSessions: PiSessionModel[];
	agentEntries: WorkflowAgentEntry[];
	monitorModels: WorkflowMonitorModel[];
	monitorRunIndex: number;
	monitorAgentIndex: number;
	runIndex: number;
	activityIndex: number;
	sessionIndex: number;
	workflowIndex: number;
	patternIndex: number;
	agentIndex: number;
	selectedMonitor: () => WorkflowMonitorModel | undefined;
	selectedAgent: () => AgentMonitorModel | undefined;
	selectedAgentEntry: () => WorkflowAgentEntry | undefined;
};

export function appendDashboardTabContent(host: DashboardRenderHost, lines: string[], theme: DashboardThemeFns): void {
	const { line, accent, muted, success, error, warning, dim } = theme;
	if (host.tab === "monitor") {
		lines.push(
			...renderMonitorView(
				host.selectedMonitor(),
				host.monitorModels,
				host.monitorRunIndex,
				host.monitorAgentIndex,
				host.selectedAgent(),
				{ line, accent, muted, success, error, warning, dim },
			),
		);
	} else if (host.tab === "agents") {
		lines.push(
			...renderAgentsView(host.agentEntries, host.agentIndex, host.runs, host.selectedAgentEntry(), {
				line,
				accent,
				muted,
				success,
				error,
				warning,
				dim,
			}),
		);
	} else if (host.tab === "sessions") {
		lines.push(...renderSessionsView(host.piSessions, host.sessionIndex, { line, accent, muted, success, warning }));
	} else if (host.tab === "runs") {
		lines.push(...renderRunsView(host.runs, host.runIndex, { line, accent, muted, success, error, dim }));
	} else if (host.tab === "workflows") {
		lines.push(...renderWorkflowsView(host.workflows, host.workflowIndex, { line, accent, muted, warning }));
	} else if (host.tab === "patterns") {
		lines.push(...renderPatternsView(host.patternIndex, { line, accent, muted, warning }));
	} else {
		lines.push(
			...renderActivityView(host.runs, host.activity, host.activityIndex, {
				line,
				accent,
				muted,
				success,
				error,
				warning,
			}),
		);
	}
}
