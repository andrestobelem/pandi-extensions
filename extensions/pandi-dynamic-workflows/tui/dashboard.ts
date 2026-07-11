/**
 * WorkflowDashboard — the main /workflow TUI dashboard class (tabbed monitor of runs,
 * agents, sessions, runs, workflows, patterns, and activity) plus its tab constant,
 * reselect helper, and the DashboardSelection result type.
 *
 * Pure UI over already-derived models; the collectors and openWorkflowDashboard stay in
 * index.ts. Tab list views live in workflow-dashboard-views.ts; monitor/agents tabs in
 * workflow-dashboard-monitor.ts; chrome (header/help) in workflow-dashboard-chrome.ts;
 * keyboard/input in workflow-dashboard-input.ts; tabs/selection/reselect in dashboard-selection.ts.
 * Fully-deferred cycle:
 * the class reads compactInline only inside methods; runtime
 * constants come from runtime-constants.ts, and index.ts imports the class back
 * (instantiated only inside the openWorkflowDashboard body) plus WorkflowDashboardTab/
 * DashboardSelection as erased types. Model types cross as import type. Run derivations
 * come from the run-state / event-parser / presentation / render-utils / templates
 * siblings. Extracted byte-identically.
 */

import { WORKFLOW_PATTERN_CATALOG } from "../lib/pattern-catalog.js";
import { compactInline, formatElapsedMs } from "../lib/presentation.js";
import type { PiSessionModel } from "../pi-session.js";
import type { AgentMonitorModel, WorkflowDefinition, WorkflowRunRecord } from "../types.js";
import { renderDashboardChrome } from "./chrome.js";
import type {
	WorkflowActivityEntry,
	WorkflowAgentEntry,
	WorkflowDashboardResult,
	WorkflowMonitorModel,
} from "./collectors.js";
import { activeTabNav, selectedAgent, selectedRun } from "./dashboard-nav.js";
import { appendDashboardTabContent } from "./dashboard-render.js";
import {
	type DashboardSelection,
	reselectIndexByKey,
	WORKFLOW_DASHBOARD_TABS,
	type WorkflowDashboardTab,
} from "./dashboard-selection.js";
import { type DashboardInputHost, handleDashboardInput } from "./input.js";
import { renderSafeInline } from "./render-utils.js";

export type { DashboardSelection, WorkflowDashboardTab } from "./dashboard-selection.js";

export class WorkflowDashboard implements DashboardInputHost {
	tab: WorkflowDashboardTab;
	workflowIndex = 0;
	runIndex = 0;
	activityIndex = 0;
	sessionIndex = 0;
	agentIndex = 0;
	monitorAgentIndex = 0;
	monitorRunIndex = 0;
	patternIndex = 0;
	showHelp = false;
	runs: WorkflowRunRecord[];
	activity: WorkflowActivityEntry[];
	piSessions: PiSessionModel[];
	monitorModels: WorkflowMonitorModel[];
	agentEntries: WorkflowAgentEntry[];
	// Salud de actualización: la actualización en segundo plano de 1.5s marca éxito/falla aquí para que
	// el encabezado pueda publicitar recencia y exponer errores de lectura en lugar de
	// congelarse en un rechazo no manejado.
	private lastRefreshAt = Date.now();
	private lastRefreshError: string | undefined;

	markRefreshOk(): void {
		this.lastRefreshAt = Date.now();
		this.lastRefreshError = undefined;
	}

	markRefreshError(error: string): void {
		this.lastRefreshError = renderSafeInline(compactInline(error, 80));
	}

	private refreshStatus(muted: (s: string) => string, error: (s: string) => string): string {
		if (this.lastRefreshError) return error(`⚠ falló el refresh: ${this.lastRefreshError}`);
		return muted(`actualizado hace ${formatElapsedMs(Math.max(0, Date.now() - this.lastRefreshAt))}`);
	}

	constructor(
		readonly workflows: WorkflowDefinition[],
		runs: WorkflowRunRecord[],
		activity: WorkflowActivityEntry[],
		piSessions: PiSessionModel[],
		monitorModels: WorkflowMonitorModel[],
		agentEntries: WorkflowAgentEntry[],
		private readonly theme: any,
		readonly requestRender: () => void,
		readonly done: (result: WorkflowDashboardResult | null) => void,
		initialTab: WorkflowDashboardTab = "monitor",
		restore?: DashboardSelection,
		readonly sessionPicker = false,
	) {
		this.runs = runs;
		this.activity = activity;
		this.piSessions = piSessions;
		this.monitorModels = monitorModels;
		this.agentEntries = agentEntries;
		this.tab = restore?.tab ?? initialTab;
		if (restore) {
			// Restauración de mejor esfuerzo para que reabriendo el panel después de una acción mantenga
			// al usuario donde estaba; los índices se limitan a las listas recién recargadas.
			const clamp = (value: number, length: number) => Math.max(0, Math.min(value, Math.max(0, length - 1)));
			this.workflowIndex = clamp(restore.workflowIndex, workflows.length);
			this.runIndex = clamp(restore.runIndex, runs.length);
			this.activityIndex = clamp(restore.activityIndex, activity.length);
			this.sessionIndex = clamp(restore.sessionIndex, piSessions.length);
			this.agentIndex = clamp(restore.agentIndex, agentEntries.length);
			this.patternIndex = clamp(restore.patternIndex, WORKFLOW_PATTERN_CATALOG.length);
			// Restaura el RUN enfocado primero, luego limita el índice del agente contra ESE
			// agentes de la ejecución (no los de la ejecución activa/primera) para que ambas mitades del Monitor
			// master-detail vuelvan adonde el usuario las dejó.
			this.monitorRunIndex = clamp(restore.monitorRunIndex ?? 0, monitorModels.length);
			const monitorAgents = monitorModels[this.monitorRunIndex]?.agents.length ?? 0;
			this.monitorAgentIndex = clamp(restore.monitorAgentIndex, monitorAgents);
		}
	}

	getSelection(): DashboardSelection {
		return {
			tab: this.tab,
			workflowIndex: this.workflowIndex,
			runIndex: this.runIndex,
			activityIndex: this.activityIndex,
			sessionIndex: this.sessionIndex,
			agentIndex: this.agentIndex,
			monitorAgentIndex: this.monitorAgentIndex,
			monitorRunIndex: this.monitorRunIndex,
			patternIndex: this.patternIndex,
		};
	}

	setRuns(runs: WorkflowRunRecord[]): void {
		this.runIndex = reselectIndexByKey(this.runs, this.runIndex, runs, (run) => run.runId);
		this.runs = runs;
	}

	setActivity(activity: WorkflowActivityEntry[]): void {
		this.activityIndex = reselectIndexByKey(
			this.activity,
			this.activityIndex,
			activity,
			(entry) => `${entry.runId}|${entry.time}|${entry.message}`,
		);
		this.activity = activity;
	}

	setPiSessions(sessions: PiSessionModel[]): void {
		this.sessionIndex = reselectIndexByKey(
			this.piSessions,
			this.sessionIndex,
			sessions,
			(session) => session.sessionId ?? session.sessionFile ?? session.file ?? String(session.pid),
		);
		this.piSessions = sessions;
	}

	setAgentEntries(entries: WorkflowAgentEntry[]): void {
		this.agentIndex = reselectIndexByKey(
			this.agentEntries,
			this.agentIndex,
			entries,
			(entry) => `${entry.run.runId}#${entry.agent.id}`,
		);
		this.agentEntries = entries;
	}

	setMonitorModels(models: WorkflowMonitorModel[]): void {
		const previousModel = this.selectedMonitor();
		const previousAgent = previousModel?.agents[this.monitorAgentIndex];
		this.monitorModels = models;
		// Keep the focused run stable across refreshes (the active set can change).
		const foundRun = previousModel ? models.findIndex((model) => model.runId === previousModel.runId) : -1;
		this.monitorRunIndex =
			foundRun >= 0 ? foundRun : Math.max(0, Math.min(this.monitorRunIndex, Math.max(0, models.length - 1)));
		const agents = this.selectedMonitor()?.agents ?? [];
		const found = previousAgent ? agents.findIndex((agent) => agent.id === previousAgent.id) : -1;
		this.monitorAgentIndex = found >= 0 ? found : Math.min(this.monitorAgentIndex, Math.max(0, agents.length - 1));
	}

	invalidate(): void {}

	moveTab(delta: number): void {
		const current = WORKFLOW_DASHBOARD_TABS.indexOf(this.tab);
		const next = (current + delta + WORKFLOW_DASHBOARD_TABS.length) % WORKFLOW_DASHBOARD_TABS.length;
		this.tab = WORKFLOW_DASHBOARD_TABS[next]!;
		this.requestRender();
	}

	selectedMonitor(): WorkflowMonitorModel | undefined {
		if (this.monitorModels.length === 0) return undefined;
		const index = Math.max(0, Math.min(this.monitorRunIndex, this.monitorModels.length - 1));
		return this.monitorModels[index];
	}

	selectedRun(): WorkflowRunRecord | undefined {
		return selectedRun(this.navHost(), this.tab);
	}

	private selectedAgentEntry(): WorkflowAgentEntry | undefined {
		return this.agentEntries[this.agentIndex];
	}

	selectedAgent(): AgentMonitorModel | undefined {
		return selectedAgent(this.navHost(), this.tab);
	}

	private navHost() {
		return {
			tab: this.tab,
			workflows: this.workflows,
			runs: this.runs,
			activity: this.activity,
			piSessions: this.piSessions,
			agentEntries: this.agentEntries,
			workflowIndex: this.workflowIndex,
			runIndex: this.runIndex,
			activityIndex: this.activityIndex,
			sessionIndex: this.sessionIndex,
			agentIndex: this.agentIndex,
			monitorAgentIndex: this.monitorAgentIndex,
			patternIndex: this.patternIndex,
			selectedMonitor: () => this.selectedMonitor(),
			setWorkflowIndex: (value: number) => {
				this.workflowIndex = value;
			},
			setRunIndex: (value: number) => {
				this.runIndex = value;
			},
			setActivityIndex: (value: number) => {
				this.activityIndex = value;
			},
			setSessionIndex: (value: number) => {
				this.sessionIndex = value;
			},
			setAgentIndex: (value: number) => {
				this.agentIndex = value;
			},
			setMonitorAgentIndex: (value: number) => {
				this.monitorAgentIndex = value;
			},
			setPatternIndex: (value: number) => {
				this.patternIndex = value;
			},
		};
	}

	activeListLength(): number {
		return activeTabNav(this.navHost()).length();
	}

	getActiveIndex(): number {
		return activeTabNav(this.navHost()).getIndex();
	}

	setActiveIndex(value: number): void {
		const nav = activeTabNav(this.navHost());
		const clamped = Math.max(0, Math.min(nav.length() - 1, value));
		nav.setIndex(clamped);
	}

	handleInput(data: string): void {
		handleDashboardInput(this, data);
	}

	render(width: number): string[] {
		const chrome = renderDashboardChrome(
			{
				tab: this.tab,
				showHelp: this.showHelp,
				theme: this.theme,
				runs: this.runs,
				selectedRun: () => this.selectedRun(),
				selectedMonitor: () => this.selectedMonitor(),
				refreshStatus: (muted, error) => this.refreshStatus(muted, error),
			},
			width,
		);
		if ("helpOnly" in chrome) return chrome.helpOnly;
		const { lines, theme } = chrome;
		const { line, accent, muted, success, error, warning, dim } = theme;
		appendDashboardTabContent(
			{
				tab: this.tab,
				workflows: this.workflows,
				runs: this.runs,
				activity: this.activity,
				piSessions: this.piSessions,
				agentEntries: this.agentEntries,
				monitorModels: this.monitorModels,
				monitorRunIndex: this.monitorRunIndex,
				monitorAgentIndex: this.monitorAgentIndex,
				runIndex: this.runIndex,
				activityIndex: this.activityIndex,
				sessionIndex: this.sessionIndex,
				workflowIndex: this.workflowIndex,
				patternIndex: this.patternIndex,
				agentIndex: this.agentIndex,
				selectedMonitor: () => this.selectedMonitor(),
				selectedAgent: () => this.selectedAgent(),
				selectedAgentEntry: () => this.selectedAgentEntry(),
			},
			lines,
			{ line, accent, muted, success, error, warning, dim },
		);
		return lines;
	}
}
