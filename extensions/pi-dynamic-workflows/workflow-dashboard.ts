/**
 * WorkflowDashboard — the main /workflow TUI dashboard class (tabbed monitor of runs,
 * agents, sessions, runs, workflows, patterns, and activity) plus its tab constant,
 * window/reselect helpers, and the DashboardSelection result type.
 *
 * Pure UI over already-derived models; the collectors and openWorkflowDashboard stay in
 * index.ts. Fully-deferred cycle: the class reads canCancelRun/canRerunRun/compactInline/
 * PI_SESSION_HEARTBEAT_MS from ./index.js only inside methods; index.ts imports the class
 * back (instantiated only inside the openWorkflowDashboard body) plus WorkflowDashboardTab/
 * DashboardSelection as erased types. Model types cross as import type. Run derivations
 * come from the run-state / event-parser / presentation / render-utils / templates
 * siblings. Extracted byte-identically.
 */
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import {
	canRerunRun,
	type WorkflowActivityEntry,
	type WorkflowAgentEntry,
	type WorkflowDashboardResult,
	type WorkflowMonitorModel,
} from "./dashboard-collectors.js";
import { formatAgentPhase, getAgentElapsedMs } from "./event-parser.js";
import type { AgentMonitorModel, WorkflowFile, WorkflowRunRecord } from "./index.js";
import { PI_SESSION_HEARTBEAT_MS } from "./index.js";
import { getPatternUseCases, WORKFLOW_PATTERN_CATALOG } from "./pattern-scaffolds.js";
import type { PiSessionModel } from "./pi-session.js";
import { compactInline, formatElapsedMs } from "./presentation.js";
import { padRightVisible, renderSafeInline } from "./render-utils.js";
import {
	formatParallelAgents,
	formatParallelAgentsCompact,
	getRunAgentConcurrency,
	getRunCachedCalls,
	getRunElapsedMs,
	getRunLogs,
	getRunParallelAgents,
	getRunState,
	getRunStatusLabel,
	isResumableState,
} from "./run-state.js";
import { canCancelRun } from "./run-status-ui.js";

const WORKFLOW_DASHBOARD_TABS = ["monitor", "agents", "sessions", "runs", "workflows", "patterns", "activity"] as const;
export type WorkflowDashboardTab = (typeof WORKFLOW_DASHBOARD_TABS)[number];

// Keep the cursor on the same item when a list is rebuilt/reordered under it
// (lists are mtime-sorted and refreshed every 1.5s, so a fixed index would
// silently retarget destructive actions). Falls back to clamped position when
// the previously-selected item is gone.
// Compact "showing a-b/total" suffix for windowed lists; empty when the whole
// list fits, so users can tell a list is scrolled and where the window sits.
function windowLabel(total: number, start: number, count: number): string {
	if (total <= count) return "";
	const end = Math.min(total, start + count);
	return ` · ${start + 1}–${end}/${total}`;
}

function reselectIndexByKey<T>(previous: T[], previousIndex: number, next: T[], keyOf: (item: T) => string): number {
	const clamped = Math.min(previousIndex, Math.max(0, next.length - 1));
	const prev = previous[previousIndex];
	if (!prev) return clamped;
	const key = keyOf(prev);
	const found = next.findIndex((item) => keyOf(item) === key);
	return found >= 0 ? found : clamped;
}

export interface DashboardSelection {
	tab: WorkflowDashboardTab;
	workflowIndex: number;
	runIndex: number;
	activityIndex: number;
	sessionIndex: number;
	agentIndex: number;
	monitorAgentIndex: number;
	patternIndex: number;
}

export class WorkflowDashboard {
	private tab: WorkflowDashboardTab;
	private workflowIndex = 0;
	private runIndex = 0;
	private activityIndex = 0;
	private sessionIndex = 0;
	private agentIndex = 0;
	private monitorAgentIndex = 0;
	private monitorRunIndex = 0;
	private patternIndex = 0;
	private showHelp = false;
	// Refresh health: the 1.5s background refresh marks success/failure here so the
	// header can advertise recency and surface read errors instead of silently
	// freezing on an unhandled rejection.
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
		if (this.lastRefreshError) return error(`⚠ refresh failed: ${this.lastRefreshError}`);
		return muted(`updated ${formatElapsedMs(Math.max(0, Date.now() - this.lastRefreshAt))} ago`);
	}

	constructor(
		private readonly workflows: WorkflowFile[],
		private runs: WorkflowRunRecord[],
		private activity: WorkflowActivityEntry[],
		private piSessions: PiSessionModel[],
		private monitorModels: WorkflowMonitorModel[],
		private agentEntries: WorkflowAgentEntry[],
		private readonly theme: any,
		private readonly requestRender: () => void,
		private readonly done: (result: WorkflowDashboardResult | null) => void,
		initialTab: WorkflowDashboardTab = "monitor",
		restore?: DashboardSelection,
	) {
		this.tab = restore?.tab ?? initialTab;
		if (restore) {
			// Best-effort restore so reopening the dashboard after an action keeps the
			// user where they were; indices are clamped to the freshly-reloaded lists.
			const clamp = (value: number, length: number) => Math.max(0, Math.min(value, Math.max(0, length - 1)));
			this.workflowIndex = clamp(restore.workflowIndex, workflows.length);
			this.runIndex = clamp(restore.runIndex, runs.length);
			this.activityIndex = clamp(restore.activityIndex, activity.length);
			this.sessionIndex = clamp(restore.sessionIndex, piSessions.length);
			this.agentIndex = clamp(restore.agentIndex, agentEntries.length);
			this.patternIndex = clamp(restore.patternIndex, WORKFLOW_PATTERN_CATALOG.length);
			const monitorAgents = (monitorModels.find((model) => model.active) ?? monitorModels[0])?.agents.length ?? 0;
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

	private moveTab(delta: number): void {
		const current = WORKFLOW_DASHBOARD_TABS.indexOf(this.tab);
		const next = (current + delta + WORKFLOW_DASHBOARD_TABS.length) % WORKFLOW_DASHBOARD_TABS.length;
		this.tab = WORKFLOW_DASHBOARD_TABS[next]!;
		this.requestRender();
	}

	private selectedMonitor(): WorkflowMonitorModel | undefined {
		if (this.monitorModels.length === 0) return undefined;
		const index = Math.max(0, Math.min(this.monitorRunIndex, this.monitorModels.length - 1));
		return this.monitorModels[index];
	}

	private selectedRun(): WorkflowRunRecord | undefined {
		if (this.tab === "monitor") return this.selectedMonitor()?.run;
		if (this.tab === "agents") return this.selectedAgentEntry()?.run;
		if (this.tab === "runs") return this.runs[this.runIndex];
		if (this.tab === "activity") {
			const entry = this.activity[this.activityIndex];
			return entry ? this.runs.find((candidate) => candidate.runId === entry.runId) : undefined;
		}
		return undefined;
	}

	private selectedAgentEntry(): WorkflowAgentEntry | undefined {
		return this.agentEntries[this.agentIndex];
	}

	private selectedAgent(): AgentMonitorModel | undefined {
		if (this.tab === "agents") return this.selectedAgentEntry()?.agent;
		return this.selectedMonitor()?.agents[this.monitorAgentIndex];
	}

	private isDeleteInput(data: string): boolean {
		// Backspace is intentionally excluded: it reads as "go back/erase" in almost
		// every TUI, so binding it to a destructive delete was a surprising mis-hit.
		return data === "d" || matchesKey(data, Key.delete);
	}

	private activeListLength(): number {
		switch (this.tab) {
			case "monitor":
				return this.selectedMonitor()?.agents.length ?? 0;
			case "agents":
				return this.agentEntries.length;
			case "workflows":
				return this.workflows.length;
			case "patterns":
				return WORKFLOW_PATTERN_CATALOG.length;
			case "sessions":
				return this.piSessions.length;
			case "runs":
				return this.runs.length;
			case "activity":
				return this.activity.length;
			default:
				return 0;
		}
	}

	private getActiveIndex(): number {
		switch (this.tab) {
			case "monitor":
				return this.monitorAgentIndex;
			case "agents":
				return this.agentIndex;
			case "workflows":
				return this.workflowIndex;
			case "patterns":
				return this.patternIndex;
			case "sessions":
				return this.sessionIndex;
			case "runs":
				return this.runIndex;
			case "activity":
				return this.activityIndex;
			default:
				return 0;
		}
	}

	private setActiveIndex(value: number): void {
		const clamped = Math.max(0, Math.min(this.activeListLength() - 1, value));
		switch (this.tab) {
			case "monitor":
				this.monitorAgentIndex = clamped;
				break;
			case "agents":
				this.agentIndex = clamped;
				break;
			case "workflows":
				this.workflowIndex = clamped;
				break;
			case "patterns":
				this.patternIndex = clamped;
				break;
			case "sessions":
				this.sessionIndex = clamped;
				break;
			case "runs":
				this.runIndex = clamped;
				break;
			case "activity":
				this.activityIndex = clamped;
				break;
		}
	}

	handleInput(data: string): void {
		if (this.showHelp) {
			// The help overlay is a modal hint: any key dismisses it.
			this.showHelp = false;
			this.requestRender();
			return;
		}
		if (matchesKey(data, Key.escape) || data === "q") {
			this.done(null);
			return;
		}
		if (data === "?") {
			this.showHelp = true;
			this.requestRender();
			return;
		}
		if (matchesKey(data, "shift+tab")) {
			this.moveTab(-1);
			return;
		}
		if (matchesKey(data, Key.tab)) {
			this.moveTab(1);
			return;
		}
		if (matchesKey(data, Key.left)) {
			this.moveTab(-1);
			return;
		}
		if (matchesKey(data, Key.right)) {
			this.moveTab(1);
			return;
		}
		if (data === "m") {
			this.tab = "monitor";
			this.requestRender();
			return;
		}
		if (data === "A" || (data === "n" && this.tab !== "patterns")) {
			this.tab = "agents";
			this.requestRender();
			return;
		}
		if (data === "a") {
			this.tab = "activity";
			this.requestRender();
			return;
		}
		if (data === "s") {
			this.tab = "sessions";
			this.requestRender();
			return;
		}
		if (data === "w") {
			this.tab = "workflows";
			this.requestRender();
			return;
		}
		if (data === "p") {
			this.tab = "patterns";
			this.requestRender();
			return;
		}
		if (data === "R") {
			this.tab = "runs";
			this.requestRender();
			return;
		}
		if (matchesKey(data, Key.up) || data === "k") {
			if (this.tab === "monitor" && (this.selectedMonitor()?.agents.length ?? 0) > 0)
				this.monitorAgentIndex = Math.max(0, this.monitorAgentIndex - 1);
			else if (this.tab === "agents") this.agentIndex = Math.max(0, this.agentIndex - 1);
			else if (this.tab === "workflows") this.workflowIndex = Math.max(0, this.workflowIndex - 1);
			else if (this.tab === "patterns") this.patternIndex = Math.max(0, this.patternIndex - 1);
			else if (this.tab === "sessions") this.sessionIndex = Math.max(0, this.sessionIndex - 1);
			else if (this.tab === "runs") this.runIndex = Math.max(0, this.runIndex - 1);
			else if (this.tab === "activity") this.activityIndex = Math.max(0, this.activityIndex - 1);
			this.requestRender();
			return;
		}
		if (matchesKey(data, Key.down) || data === "j") {
			if (this.tab === "monitor" && (this.selectedMonitor()?.agents.length ?? 0) > 0)
				this.monitorAgentIndex = Math.min(
					Math.max(0, (this.selectedMonitor()?.agents.length ?? 1) - 1),
					this.monitorAgentIndex + 1,
				);
			else if (this.tab === "agents")
				this.agentIndex = Math.min(Math.max(0, this.agentEntries.length - 1), this.agentIndex + 1);
			else if (this.tab === "workflows")
				this.workflowIndex = Math.min(Math.max(0, this.workflows.length - 1), this.workflowIndex + 1);
			else if (this.tab === "patterns")
				this.patternIndex = Math.min(Math.max(0, WORKFLOW_PATTERN_CATALOG.length - 1), this.patternIndex + 1);
			else if (this.tab === "sessions")
				this.sessionIndex = Math.min(Math.max(0, this.piSessions.length - 1), this.sessionIndex + 1);
			else if (this.tab === "runs") this.runIndex = Math.min(Math.max(0, this.runs.length - 1), this.runIndex + 1);
			else if (this.tab === "activity")
				this.activityIndex = Math.min(Math.max(0, this.activity.length - 1), this.activityIndex + 1);
			this.requestRender();
			return;
		}
		if (
			matchesKey(data, Key.pageUp) ||
			matchesKey(data, Key.pageDown) ||
			matchesKey(data, Key.home) ||
			matchesKey(data, Key.end) ||
			data === "G"
		) {
			// Page/Home/End (and vim G = last) jump within the active list, mirroring the live agent view.
			const page = 10;
			if (this.activeListLength() > 0) {
				if (matchesKey(data, Key.pageUp)) this.setActiveIndex(this.getActiveIndex() - page);
				else if (matchesKey(data, Key.pageDown)) this.setActiveIndex(this.getActiveIndex() + page);
				else if (matchesKey(data, Key.home)) this.setActiveIndex(0);
				else this.setActiveIndex(this.activeListLength() - 1);
				this.requestRender();
			}
			return;
		}
		if (this.tab === "workflows") {
			const workflow = this.workflows[this.workflowIndex];
			if (!workflow) return;
			if (matchesKey(data, Key.enter) || data === "g") this.done({ type: "graph", workflow });
			else if (data === "r") this.done({ type: "run", workflow });
			else if (this.isDeleteInput(data)) this.done({ type: "deleteWorkflow", workflow });
			return;
		}
		if (this.tab === "patterns") {
			const pattern = WORKFLOW_PATTERN_CATALOG[this.patternIndex];
			if (!pattern) return;
			if (matchesKey(data, Key.enter) || data === "n" || data === "u") this.done({ type: "newPattern", pattern });
			return;
		}
		if (this.tab === "sessions") {
			const session = this.piSessions[this.sessionIndex];
			if (!session) return;
			if (matchesKey(data, Key.enter)) this.done({ type: "switchSession", session });
			return;
		}
		const run = this.selectedRun();
		if (!run) return;
		if (this.tab === "monitor") {
			if (data === "[" || data === "]") {
				this.cycleMonitorRun(data === "]" ? 1 : -1);
				return;
			}
			this.handleRunSelectionInput(data, run, this.selectedAgent());
			return;
		}
		if (this.tab === "agents") {
			if (data === "f") {
				this.jumpToNextFailedAgent();
				return;
			}
			this.handleRunSelectionInput(data, run, this.selectedAgent());
			return;
		}
		this.handleRunSelectionInput(data, run);
	}

	// Single source of truth for the run-action shortcuts shared by every
	// run-bearing tab (monitor, agents, runs, activity): Enter/o agent output,
	// v run view, g graph, c/x cancel (gated), r rerun (gated), d/Del delete.
	// `agent` is only passed where a sub-agent row is selectable (monitor/agents);
	// without it Enter/o falls through to the run view, matching prior behavior.
	// Extracted from three byte-identical branches to stop them drifting apart.
	private handleRunSelectionInput(data: string, run: WorkflowRunRecord, agent?: AgentMonitorModel): void {
		if ((matchesKey(data, Key.enter) || data === "o") && agent) this.done({ type: "agent", run, agent });
		else if (matchesKey(data, Key.enter) || data === "v") this.done({ type: "view", run });
		else if (data === "g") this.done({ type: "graph", run });
		else if ((data === "c" || data === "x") && canCancelRun(run)) this.done({ type: "cancel", run });
		else if (data === "r" && canRerunRun(run)) this.done({ type: "rerun", run });
		else if (this.isDeleteInput(data)) this.done({ type: "deleteRun", run });
	}

	// Jump selection to the next failed agent (forward, wrapping). Turns the
	// failed:N counter into one-key triage for large fan-outs.
	private jumpToNextFailedAgent(): void {
		const n = this.agentEntries.length;
		if (n === 0) return;
		for (let step = 1; step <= n; step++) {
			const index = (this.agentIndex + step) % n;
			if (this.agentEntries[index]?.agent.state === "failed") {
				this.agentIndex = index;
				this.requestRender();
				return;
			}
		}
	}

	// Cycle the focused active run in the Monitor (master-detail over all active runs).
	private cycleMonitorRun(delta: number): void {
		const n = this.monitorModels.length;
		if (n <= 1) return;
		this.monitorRunIndex = (this.monitorRunIndex + delta + n) % n;
		this.monitorAgentIndex = 0;
		this.requestRender();
	}

	private renderHelp(
		w: number,
		line: (s: string) => string,
		accent: (s: string) => string,
		muted: (s: string) => string,
	): string[] {
		return [
			line(accent("Pi Dynamic Workflows — keyboard help")),
			line(muted("Press any key to close")),
			line(muted("─".repeat(Math.min(w, 120)))),
			line(accent("Tabs")),
			line("  Tab / ← / → cycle tabs · Shift+Tab previous"),
			line("  m Monitor · A Agents · a Activity · s Sessions · w Workflows · p Patterns · R Runs"),
			line(accent("Navigate")),
			line("  ↑ ↓ / j k move · PgUp / PgDn page · Home / End / G first / last"),
			line("  [ ] switch active run (Monitor)"),
			line(accent("Actions")),
			line("  Enter / o agent output · v run view · g graph"),
			line("  f next failed agent (Agents tab)"),
			line("  c / x cancel active · r rerun (confirm) · d / Del delete (confirm)"),
			line("  Patterns: Enter / n / u use pattern · Workflows: Enter / g graph, r run, d delete"),
			line("  Sessions: Enter switch session"),
			line(accent("Other")),
			line("  ? toggle this help · q / Esc close dashboard"),
		];
	}

	render(width: number): string[] {
		if (width <= 0) return [];
		const w = width;
		const accent = (s: string) => this.theme.fg("accent", s);
		const muted = (s: string) => this.theme.fg("muted", s);
		const success = (s: string) => this.theme.fg("success", s);
		const error = (s: string) => this.theme.fg("error", s);
		const warning = (s: string) => this.theme.fg("warning", s);
		const line = (s: string) => truncateToWidth(s, w, "…");
		if (this.showHelp) return this.renderHelp(w, line, accent, muted);
		const monitorTab = this.tab === "monitor" ? accent("[Monitor]") : muted(" Monitor ");
		const agentsTab = this.tab === "agents" ? accent("[Agents]") : muted(" Agents ");
		const sessionsTab = this.tab === "sessions" ? accent("[Sessions]") : muted(" Sessions ");
		const runsTab = this.tab === "runs" ? accent("[Runs]") : muted(" Runs ");
		const workflowTab = this.tab === "workflows" ? accent("[Workflows]") : muted(" Workflows ");
		const patternsTab = this.tab === "patterns" ? accent("[Patterns]") : muted(" Patterns ");
		const activityTab = this.tab === "activity" ? accent("[Activity]") : muted(" Activity ");
		const activeCount = this.runs.filter((run) => canCancelRun(run)).length;
		// Gate the action-bearing help on the SELECTED run so the banner never
		// advertises cancel/rerun/delete keys that the detail row won't honor.
		const selectedForActions = this.selectedRun();
		const selectedMonitorModel = this.tab === "monitor" ? this.selectedMonitor() : undefined;
		const canCancelSelected = selectedMonitorModel
			? !!selectedMonitorModel.canCancel
			: selectedForActions
				? canCancelRun(selectedForActions)
				: false;
		const canRerunSelected = selectedMonitorModel
			? !!selectedMonitorModel.canRerun
			: selectedForActions
				? canRerunRun(selectedForActions)
				: false;
		const runActions = (mid: string): string => {
			const parts = ["←→/Tab tabs", mid];
			if (canCancelSelected) parts.push("c/x cancel active");
			if (canRerunSelected) parts.push("r rerun");
			if (!canCancelSelected) parts.push("d/delete run");
			parts.push("q/esc close");
			return parts.join(" • ");
		};
		const help =
			this.tab === "patterns"
				? "←→/Tab tabs • ↑↓ navigate catalog • Enter/n use pattern • q/esc close"
				: this.tab === "workflows"
					? "←→/Tab tabs • ↑↓ navigate • Enter/g graph • r run • d/delete workflow • q/esc close"
					: this.tab === "sessions"
						? "←→/Tab tabs • ↑↓ select Pi session • Enter switch • q/esc close"
						: this.tab === "monitor"
							? runActions("↑↓ agents • [ ] switch run • Enter/o agent detail • v run • g graph")
							: this.tab === "agents"
								? runActions("↑↓ select agent • f next failed • Enter/o detail+prompt • v run • g graph")
								: runActions("↑↓ navigate • Enter/v view • g graph");
		const lines: string[] = [
			line(
				accent("Pi Dynamic Workflows") +
					muted("  •  ") +
					monitorTab +
					" " +
					agentsTab +
					" " +
					sessionsTab +
					" " +
					runsTab +
					" " +
					workflowTab +
					" " +
					patternsTab +
					" " +
					activityTab +
					(activeCount ? accent(`  ▶ ${activeCount} active`) : ""),
			),
			line(muted("? help • ") + this.refreshStatus(muted, error) + muted(` • ${help}`)),
			line(muted("─".repeat(Math.min(w, 120)))),
		];

		if (this.tab === "monitor") this.renderMonitor(lines, line, accent, muted, success, error, warning);
		else if (this.tab === "agents") this.renderAgents(lines, line, accent, muted, success, error, warning);
		else if (this.tab === "sessions") this.renderSessions(lines, line, accent, muted, success, warning);
		else if (this.tab === "runs") this.renderRuns(lines, line, accent, muted, success, error);
		else if (this.tab === "workflows") this.renderWorkflows(lines, line, accent, muted, warning);
		else if (this.tab === "patterns") this.renderPatterns(lines, line, accent, muted, warning);
		else this.renderActivity(lines, line, accent, muted, success, error, warning);
		return lines;
	}

	private renderMonitor(
		lines: string[],
		line: (s: string) => string,
		accent: (s: string) => string,
		muted: (s: string) => string,
		success: (s: string) => string,
		error: (s: string) => string,
		warning: (s: string) => string,
	): void {
		const model = this.selectedMonitor();
		if (!model) {
			lines.push(line(warning("No workflow runs found.")));
			lines.push(line(muted("Start one with /workflow start <name> {json} or dynamic_workflow action=start.")));
			return;
		}

		const stateColor =
			model.state === "completed"
				? success
				: model.state === "running"
					? accent
					: model.state === "stale"
						? warning
						: error;
		const label = (name: string, value: string) =>
			lines.push(line(`${muted(padRightVisible(`${name}:`, 11))} ${value}`));
		const statusTail = model.active ? accent("active") : model.stale ? warning("stale") : muted("inactive");
		const total = this.monitorModels.length;
		if (total > 1) {
			lines.push(
				line(
					accent(`Active runs (${total})`) + muted(` • [ ] switch • showing ${this.monitorRunIndex + 1}/${total}`),
				),
			);
			for (let i = 0; i < total; i++) {
				const m = this.monitorModels[i];
				const focused = i === this.monitorRunIndex;
				const prefix = focused ? accent("› ") : "  ";
				const glyph =
					m.state === "completed"
						? success("✓")
						: m.state === "running"
							? accent("▶")
							: m.state === "stale"
								? warning("?")
								: error("✗");
				const parallel =
					m.agentConcurrency && m.agentConcurrency > 0
						? `${m.parallelAgents}/${m.agentConcurrency}`
						: String(m.parallelAgents);
				lines.push(
					line(
						`${prefix}${glyph} ${m.workflow} ${muted(m.runId)} ${m.agentsDone}/${m.agentsStarted} ${muted(`parallel:${parallel}`)}`,
					),
				);
			}
			lines.push(line(muted("")));
		}
		const title =
			total > 1
				? `Active run ${this.monitorRunIndex + 1}/${total}`
				: model.priority === "active"
					? "Active run"
					: "Latest run";
		lines.push(line(accent(title)));
		label("workflow", model.workflow);
		label("state", `${stateColor(getRunStatusLabel(model.run))} ${muted("•")} ${statusTail}`);
		label("elapsed", formatElapsedMs(model.elapsedMs));
		label("agents", `${model.agentsDone}/${model.agentsStarted} done/started`);
		label(
			"parallel",
			`${model.agentConcurrency && model.agentConcurrency > 0 ? `${model.parallelAgents}/${model.agentConcurrency}` : model.parallelAgents} running${model.peakParallelAgents === undefined ? "" : ` • peak:${model.peakParallelAgents}`}`,
		);
		label("bash", `${model.bashDone} done`);
		label("artifacts", String(model.artifactCount));
		label("run", model.runId);
		label("runDir", model.runDir);
		const last = model.lastLog
			? `${model.lastLog.time.slice(11, 19)} ${renderSafeInline(model.lastLog.message)}`
			: "No logs recorded yet.";
		label("last", last);
		if (model.run.error) label("error", error(renderSafeInline(compactInline(model.run.error, 200))));
		const actions =
			model.agents.length > 0
				? ["←→ tabs", "↑↓ select agent", "Enter/o agent output", "v run", "g graph"]
				: ["←→ tabs", "Enter/v view", "g graph"];
		if (model.canCancel) actions.push("c/x cancel active");
		if (model.canRerun) actions.push("r rerun (confirm)");
		if (!model.canCancel) actions.push("d/delete run artifacts");
		lines.push(line(muted("")));
		lines.push(line(muted(actions.join(" • "))));
		this.renderMonitorAgents(lines, line, model, accent, muted, success, error, warning);
	}

	private agentStateLabel(
		agent: AgentMonitorModel,
		accent: (s: string) => string,
		muted: (s: string) => string,
		success: (s: string) => string,
		error: (s: string) => string,
	): string {
		if (agent.state === "completed") return success("✓ done");
		if (agent.state === "running") return accent("▶ running");
		if (agent.state === "cached") return muted("♻ cached");
		if (agent.state === "failed") return error("✗ failed");
		return muted("? unknown");
	}

	private renderMonitorAgents(
		lines: string[],
		line: (s: string) => string,
		model: WorkflowMonitorModel,
		accent: (s: string) => string,
		muted: (s: string) => string,
		success: (s: string) => string,
		error: (s: string) => string,
		warning: (s: string) => string,
	): void {
		if (model.agents.length === 0) return;
		lines.push(line(muted("")));
		const start = Math.max(0, Math.min(this.monitorAgentIndex - 6, model.agents.length - 12));
		const visible = model.agents.slice(start, start + 12);
		lines.push(
			line(
				accent(`Agents (${model.agents.length})`) +
					muted(windowLabel(model.agents.length, start, 12)) +
					muted(
						` • parallel ${model.agentConcurrency && model.agentConcurrency > 0 ? `${model.parallelAgents}/${model.agentConcurrency}` : model.parallelAgents}${model.peakParallelAgents === undefined ? "" : ` • peak ${model.peakParallelAgents}`}`,
					),
			),
		);
		for (let i = 0; i < visible.length; i++) {
			const index = start + i;
			const agent = visible[i];
			const selected = index === this.monitorAgentIndex;
			const prefix = selected ? accent("› ") : "  ";
			const state = this.agentStateLabel(agent, accent, muted, success, error);
			const agentElapsedMs = getAgentElapsedMs(agent);
			const elapsed = agentElapsedMs === undefined ? "elapsed:…" : `elapsed:${formatElapsedMs(agentElapsedMs)}`;
			const phase = formatAgentPhase(agent);
			const code =
				agent.code === undefined ? "" : agent.code === 0 ? muted(` code:0`) : error(` code:${agent.code}`);
			const prompt = agent.promptAvailable ? success("prompt✓") : warning("prompt?");
			const schema = agent.schemaOk === undefined ? "" : agent.schemaOk ? muted(` schema:ok`) : error(` schema:bad`);
			const tools = muted(` tools:${agent.tools?.length ? agent.tools.length : "default"}`);
			const skills = muted(
				` skills:${agent.skills?.length ? agent.skills.length : agent.includeSkills === false ? "off" : "default"}`,
			);
			const extensions = muted(
				` ext:${agent.extensions?.length ? agent.extensions.length : agent.includeExtensions ? "default" : "off"}`,
			);
			const keys =
				muted(` keys:${agent.keys?.length ? agent.keys.length : agent.isolatedEnv ? "none" : "default"}`) +
				(agent.missingKeys?.length ? warning(` missing:${agent.missingKeys.length}`) : "");
			lines.push(
				line(
					`${prefix}${state} #${agent.id}${phase ? ` ${accent(phase)}` : ""} ${renderSafeInline(agent.name)} ${muted(elapsed)}${code} ${prompt}${schema}${tools}${skills}${extensions}${keys}`,
				),
			);
		}
		const selected = this.selectedAgent();
		if (!selected) return;
		lines.push(line(muted("")));
		lines.push(line(accent("Selected agent")));
		lines.push(
			line(
				`agent: #${selected.id} ${formatAgentPhase(selected) ? `${formatAgentPhase(selected)} ` : ""}${selected.name}`,
			),
		);
		const selectedElapsedMs = getAgentElapsedMs(selected);
		lines.push(
			line(
				`state: ${renderSafeInline(selected.state)}${selectedElapsedMs === undefined ? "" : ` • ${formatElapsedMs(selectedElapsedMs)}`}${selected.code === undefined ? "" : ` • code ${selected.code}`}`,
			),
		);
		if (formatAgentPhase(selected))
			lines.push(
				line(
					`phase: ${formatAgentPhase(selected)}${selected.phaseLabel ? muted(` • ${selected.phaseLabel}`) : ""}`,
				),
			);
		lines.push(
			line(
				`prompt: ${selected.promptAvailable ? success("available") : warning("not available")} ${selected.artifactPath ? muted(`• ${selected.artifactPath}`) : ""}`,
			),
		);
		lines.push(
			line(
				`tools: ${selected.tools?.length ? selected.tools.join(", ") : "default"}${selected.excludeTools?.length ? ` • exclude: ${selected.excludeTools.join(", ")}` : ""}`,
			),
		);
		lines.push(
			line(
				`skills: ${selected.skills?.length ? `${selected.skills.join(", ")}${selected.includeSkills ? " + discovery" : " (explicit only)"}` : selected.includeSkills === false ? "disabled" : "default discovery"}`,
			),
		);
		lines.push(
			line(
				`extensions: ${selected.extensions?.length ? `${selected.extensions.join(", ")}${selected.includeExtensions ? " + discovery" : " (explicit only)"}` : selected.includeExtensions ? "default discovery" : "disabled"}`,
			),
		);
		lines.push(
			line(
				`keys: ${selected.keys?.length ? selected.keys.join(", ") : selected.isolatedEnv ? "none selected" : "default inherited environment"}${selected.missingKeys?.length ? warning(` • missing: ${selected.missingKeys.join(", ")}`) : ""}`,
			),
		);
		if (selected.promptPreview)
			lines.push(line(`prompt preview: ${renderSafeInline(compactInline(selected.promptPreview, 220))}`));
		if (selected.output) lines.push(line(`output: ${renderSafeInline(compactInline(selected.output, 220))}`));
	}

	private renderAgents(
		lines: string[],
		line: (s: string) => string,
		accent: (s: string) => string,
		muted: (s: string) => string,
		success: (s: string) => string,
		error: (s: string) => string,
		warning: (s: string) => string,
	): void {
		if (this.agentEntries.length === 0) {
			lines.push(line(warning("No workflow agents found yet.")));
			lines.push(
				line(
					muted(
						"Start a workflow with subagents, then return here to inspect prompts, state, artifacts, and output.",
					),
				),
			);
			return;
		}
		const running = this.agentEntries.filter((entry) => entry.agent.state === "running").length;
		const failed = this.agentEntries.filter((entry) => entry.agent.state === "failed").length;
		const cached = this.agentEntries.filter((entry) => entry.agent.state === "cached").length;
		const activeRuns = this.runs.filter((run) => getRunState(run) === "running");
		const parallelNow = activeRuns.reduce((sum, run) => sum + getRunParallelAgents(run), 0);
		const parallelLimit = activeRuns.reduce((sum, run) => sum + (getRunAgentConcurrency(run) ?? 0), 0);
		const parallelText = parallelLimit > 0 ? `${parallelNow}/${parallelLimit}` : String(parallelNow);
		const start = Math.max(0, Math.min(this.agentIndex - 7, this.agentEntries.length - 14));
		const visible = this.agentEntries.slice(start, start + 14);
		lines.push(
			line(
				`${accent("All agents")} ${muted(`(${this.agentEntries.length})`)}${muted(windowLabel(this.agentEntries.length, start, 14))} ${accent(`parallel:${parallelText}`)} ${running ? accent(`running:${running}`) : muted("running:0")} ${failed ? error(`failed:${failed}`) : muted("failed:0")} ${cached ? muted(`cached:${cached}`) : ""}`,
			),
		);
		for (let i = 0; i < visible.length; i++) {
			const index = start + i;
			const entry = visible[i];
			const selected = index === this.agentIndex;
			const prefix = selected ? accent("› ") : "  ";
			const state = this.agentStateLabel(entry.agent, accent, muted, success, error);
			const agentElapsedMs = getAgentElapsedMs(entry.agent);
			const elapsed = agentElapsedMs === undefined ? "elapsed:…" : `elapsed:${formatElapsedMs(agentElapsedMs)}`;
			const phase = formatAgentPhase(entry.agent);
			const prompt = entry.agent.promptAvailable ? success("prompt✓") : warning("prompt?");
			const schema =
				entry.agent.schemaOk === undefined ? "" : entry.agent.schemaOk ? muted(` schema:ok`) : error(` schema:bad`);
			const tools = muted(` tools:${entry.agent.tools?.length ? entry.agent.tools.length : "default"}`);
			const skills = muted(
				` skills:${entry.agent.skills?.length ? entry.agent.skills.length : entry.agent.includeSkills === false ? "off" : "default"}`,
			);
			const extensions = muted(
				` ext:${entry.agent.extensions?.length ? entry.agent.extensions.length : entry.agent.includeExtensions ? "default" : "off"}`,
			);
			const keys =
				muted(
					` keys:${entry.agent.keys?.length ? entry.agent.keys.length : entry.agent.isolatedEnv ? "none" : "default"}`,
				) + (entry.agent.missingKeys?.length ? warning(` missing:${entry.agent.missingKeys.length}`) : "");
			lines.push(
				line(
					`${prefix}${state} #${entry.agent.id}${phase ? ` ${accent(phase)}` : ""} ${renderSafeInline(entry.agent.name)} ${muted(`— ${entry.run.workflow} ${entry.run.runId.slice(-12)}`)} ${muted(elapsed)} ${prompt}${schema}${tools}${skills}${extensions}${keys}`,
				),
			);
		}
		const selected = this.selectedAgentEntry();
		if (!selected) return;
		const agent = selected.agent;
		const run = selected.run;
		lines.push(line(muted("")));
		lines.push(line(accent("Selected agent")));
		lines.push(line(`workflow: ${run.workflow}`));
		lines.push(line(`run: ${run.runId}`));
		lines.push(line(`parallel: ${formatParallelAgents(run)}`));
		lines.push(
			line(`agent: #${agent.id} ${formatAgentPhase(agent) ? `${formatAgentPhase(agent)} ` : ""}${agent.name}`),
		);
		const agentDetailElapsedMs = getAgentElapsedMs(agent);
		lines.push(
			line(
				`state: ${renderSafeInline(agent.state)}${agentDetailElapsedMs === undefined ? "" : ` • ${formatElapsedMs(agentDetailElapsedMs)}`}${agent.code === undefined ? "" : ` • code ${agent.code}`}${agent.schemaOk === undefined ? "" : ` • schema ${agent.schemaOk ? "ok" : "bad"}`}`,
			),
		);
		if (formatAgentPhase(agent))
			lines.push(
				line(`phase: ${formatAgentPhase(agent)}${agent.phaseLabel ? muted(` • ${agent.phaseLabel}`) : ""}`),
			);
		lines.push(
			line(
				`prompt: ${agent.promptAvailable ? success("available") : warning("not available")} ${agent.artifactPath ? muted(`• ${agent.artifactPath}`) : ""}`,
			),
		);
		lines.push(
			line(
				`tools: ${agent.tools?.length ? agent.tools.join(", ") : "default"}${agent.excludeTools?.length ? ` • exclude: ${agent.excludeTools.join(", ")}` : ""}`,
			),
		);
		lines.push(
			line(
				`skills: ${agent.skills?.length ? `${agent.skills.join(", ")}${agent.includeSkills ? " + discovery" : " (explicit only)"}` : agent.includeSkills === false ? "disabled" : "default discovery"}`,
			),
		);
		lines.push(
			line(
				`extensions: ${agent.extensions?.length ? `${agent.extensions.join(", ")}${agent.includeExtensions ? " + discovery" : " (explicit only)"}` : agent.includeExtensions ? "default discovery" : "disabled"}`,
			),
		);
		lines.push(
			line(
				`keys: ${agent.keys?.length ? agent.keys.join(", ") : agent.isolatedEnv ? "none selected" : "default inherited environment"}${agent.missingKeys?.length ? warning(` • missing: ${agent.missingKeys.join(", ")}`) : ""}`,
			),
		);
		if (agent.promptPreview)
			lines.push(line(`prompt preview: ${renderSafeInline(compactInline(agent.promptPreview, 260))}`));
		if (agent.output) lines.push(line(`output: ${renderSafeInline(compactInline(agent.output, 260))}`));
		const actions = ["Enter/o opens output+prompt", "v run", "g graph"];
		if (canCancelRun(run)) actions.push("c/x cancel active");
		if (canRerunRun(run)) actions.push("r rerun (confirm)");
		if (!canCancelRun(run)) actions.push("d/delete run artifacts");
		lines.push(line(muted(actions.join(" • "))));
	}

	private renderSessions(
		lines: string[],
		line: (s: string) => string,
		accent: (s: string) => string,
		muted: (s: string) => string,
		success: (s: string) => string,
		warning: (s: string) => string,
	): void {
		if (this.piSessions.length === 0) {
			lines.push(line(warning("No live Pi TUI/RPC sessions found.")));
			lines.push(
				line(muted("Persistent Pi sessions appear here after this extension starts and writes a heartbeat.")),
			);
			return;
		}
		const live = this.piSessions.filter((session) => session.live).length;
		const stale = this.piSessions.length - live;
		lines.push(
			line(
				`${accent("Pi sessions")} ${muted(`(${this.piSessions.length})`)} ${live ? success(`live:${live}`) : muted("live:0")} ${stale ? warning(`stale:${stale}`) : muted("stale:0")} ${muted(`heartbeat:${formatElapsedMs(PI_SESSION_HEARTBEAT_MS)}`)}`,
			),
		);
		const start = Math.max(0, Math.min(this.sessionIndex - 6, this.piSessions.length - 12));
		const visible = this.piSessions.slice(start, start + 12);
		for (let i = 0; i < visible.length; i++) {
			const index = start + i;
			const session = visible[i];
			const selected = index === this.sessionIndex;
			const prefix = selected ? accent("› ") : "  ";
			const state = session.live ? success("● live") : warning("○ stale");
			const current = session.current ? accent(" this") : "";
			const name = session.sessionName ? ` ${renderSafeInline(session.sessionName)}` : "";
			const idle = session.idle === undefined ? "" : muted(` idle:${session.idle ? "yes" : "no"}`);
			const workflows = session.activeWorkflowRuns
				? accent(` workflows:${session.activeWorkflowRuns}`)
				: muted(" workflows:0");
			const age = Number.isFinite(session.ageMs) ? `${formatElapsedMs(session.ageMs)} ago` : "unknown";
			lines.push(
				line(
					`${prefix}${state} ${session.mode} pid:${session.pid}${current}${name} ${muted(`updated:${age}`)}${idle}${workflows}`,
				),
			);
		}
		const selected = this.piSessions[this.sessionIndex];
		if (!selected) return;
		lines.push(line(muted("")));
		lines.push(line(accent("Selected Pi session")));
		lines.push(
			line(
				`status: ${selected.live ? success("live") : warning(`stale${selected.staleReason ? ` • ${selected.staleReason}` : ""}`)}${selected.current ? accent(" • this process") : ""}`,
			),
		);
		lines.push(
			line(
				`mode: ${selected.mode} • pid: ${selected.pid} • idle: ${selected.idle === undefined ? "unknown" : selected.idle ? "yes" : "no"}`,
			),
		);
		lines.push(
			line(`session: ${selected.sessionName ? `${selected.sessionName} • ` : ""}${selected.sessionId ?? "unknown"}`),
		);
		lines.push(line(`started: ${selected.startedAt} • updated: ${selected.updatedAt}`));
		lines.push(
			line(
				`workflows: ${selected.activeWorkflowRuns ?? 0} active • trusted: ${selected.trusted === undefined ? "unknown" : selected.trusted ? "yes" : "no"}`,
			),
		);
		lines.push(line(`cwd: ${selected.cwd}`));
		lines.push(line(`session file: ${selected.sessionFile ?? "(in-memory or unavailable)"}`));
		lines.push(line(`registry: ${selected.file}`));
		const action = selected.current
			? "Already in this session."
			: selected.sessionFile
				? "Enter switches this Pi to the selected session file."
				: "Enter unavailable: no session file recorded.";
		lines.push(line(muted(action)));
		lines.push(
			line(
				muted(
					`Heartbeat records are removed on clean shutdown; stale rows usually mean the Pi process died without cleanup.`,
				),
			),
		);
	}

	private renderWorkflows(
		lines: string[],
		line: (s: string) => string,
		accent: (s: string) => string,
		muted: (s: string) => string,
		warning: (s: string) => string,
	): void {
		if (this.workflows.length === 0) {
			lines.push(line(warning("No workflows found.")));
			lines.push(line(muted("Create one with /workflow new <name> or dynamic_workflow action=write.")));
			return;
		}
		const start = Math.max(0, Math.min(this.workflowIndex - 6, this.workflows.length - 12));
		const visible = this.workflows.slice(start, start + 12);
		for (let i = 0; i < visible.length; i++) {
			const index = start + i;
			const workflow = visible[i];
			const selected = index === this.workflowIndex;
			const prefix = selected ? accent("› ") : "  ";
			const scope = workflow.scope === "project" ? accent("project") : muted("global");
			lines.push(
				line(`${prefix}${workflow.name} ${muted("(")}${scope}${muted(")")} ${muted(workflow.relativePath)}`),
			);
		}
		const selected = this.workflows[this.workflowIndex];
		if (selected) {
			lines.push(line(muted("")));
			lines.push(line(accent("Selected workflow")));
			lines.push(line(`name: ${selected.name}`));
			lines.push(line(`scope: ${selected.scope}`));
			lines.push(line(`path: ${selected.path}`));
			lines.push(line(muted("Enter/g opens graph • r runs with JSON + confirm • d/delete removes workflow file")));
		}
	}

	private renderPatterns(
		lines: string[],
		line: (s: string) => string,
		accent: (s: string) => string,
		muted: (s: string) => string,
		warning: (s: string) => string,
	): void {
		if (WORKFLOW_PATTERN_CATALOG.length === 0) {
			lines.push(line(warning("No workflow patterns registered.")));
			return;
		}
		lines.push(
			line(
				`${accent("Pattern catalog")} ${muted(`(${WORKFLOW_PATTERN_CATALOG.length})`)} ${muted("• choose a scaffold, then edit before saving")}`,
			),
		);
		const start = Math.max(0, Math.min(this.patternIndex - 6, WORKFLOW_PATTERN_CATALOG.length - 12));
		const visible = WORKFLOW_PATTERN_CATALOG.slice(start, start + 12);
		for (let i = 0; i < visible.length; i++) {
			const index = start + i;
			const pattern = visible[i];
			const selected = index === this.patternIndex;
			const prefix = selected ? accent("› ") : "  ";
			lines.push(
				line(
					`${prefix}${pattern.key} ${muted("—")} ${pattern.title} ${muted(`(${pattern.primitives.join(" + ")})`)}`,
				),
			);
		}
		const selected = WORKFLOW_PATTERN_CATALOG[this.patternIndex];
		if (!selected) return;
		const useCases = getPatternUseCases(selected);
		lines.push(line(muted("")));
		lines.push(line(accent("Selected pattern")));
		lines.push(line(`key: ${selected.key}`));
		lines.push(line(`title: ${selected.title}`));
		lines.push(line(`summary: ${selected.blurb}`));
		lines.push(line(`use when: ${selected.useWhen}`));
		if (useCases.length) {
			lines.push(line(accent("Example use cases")));
			for (const useCase of useCases.slice(0, 4)) lines.push(line(`- ${useCase}`));
		}
		lines.push(line(`input: ${selected.inputHint}`));
		lines.push(line(`primitives: ${selected.primitives.join(", ")}`));
		lines.push(line(`draft name: ${selected.defaultName}`));
		lines.push(line(muted("Enter/n creates a project workflow draft from this pattern; you can edit before save.")));
	}

	private renderRuns(
		lines: string[],
		line: (s: string) => string,
		accent: (s: string) => string,
		muted: (s: string) => string,
		success: (s: string) => string,
		error: (s: string) => string,
	): void {
		if (this.runs.length === 0) {
			lines.push(line(muted("No workflow runs found.")));
			return;
		}
		const start = Math.max(0, Math.min(this.runIndex - 6, this.runs.length - 12));
		const visible = this.runs.slice(start, start + 12);
		lines.push(
			line(`${accent("Runs")} ${muted(`(${this.runs.length})`)}${muted(windowLabel(this.runs.length, start, 12))}`),
		);
		for (let i = 0; i < visible.length; i++) {
			const index = start + i;
			const run = visible[i];
			const selected = index === this.runIndex;
			const prefix = selected ? accent("› ") : "  ";
			const state = getRunState(run);
			const status =
				state === "completed"
					? success("✓")
					: state === "running"
						? accent("▶")
						: state === "stale"
							? muted("?")
							: error(state === "cancelled" ? "■" : "✗");
			const bg = run.background ? " bg" : "";
			const resumable = isResumableState(state) ? muted(" resumable") : "";
			const cached = getRunCachedCalls(run) > 0 ? muted(` cached:${getRunCachedCalls(run)}`) : "";
			const parallelCompact = formatParallelAgentsCompact(run);
			const parallel = parallelCompact === "-" ? "" : muted(` parallel:${parallelCompact}`);
			lines.push(
				line(
					`${prefix}${status} ${run.workflow}${bg} ${muted(run.runId)} ${getRunStatusLabel(run)} ${formatElapsedMs(getRunElapsedMs(run, state))} agents:${run.agentCount}${parallel}${resumable}${cached}`,
				),
			);
		}
		const selected = this.runs[this.runIndex];
		if (selected) {
			lines.push(line(muted("")));
			lines.push(line(accent("Selected run")));
			lines.push(line(`status: ${getRunStatusLabel(selected)}`));
			lines.push(line(`run: ${selected.runId}`));
			lines.push(line(`parallel: ${formatParallelAgents(selected)}`));
			lines.push(line(`dir: ${selected.runDir}`));
			if (selected.error)
				lines.push(line(`${accent("error")}: ${error(renderSafeInline(compactInline(selected.error, 200)))}`));
			for (const logEntry of getRunLogs(selected).slice(-5))
				lines.push(line(`${muted(logEntry.time.slice(11, 19))} ${renderSafeInline(logEntry.message)}`));
			const selectedState = getRunState(selected);
			const actions = ["Enter/v view", "g graph"];
			if (canCancelRun(selected)) actions.push("c/x cancel active");
			if (canRerunRun(selected)) actions.push("r rerun (confirm)");
			if (!canCancelRun(selected)) actions.push("d/delete run artifacts");
			if (isResumableState(selectedState)) actions.push(`/workflow resume ${selected.runId}`);
			lines.push(line(muted(actions.join(" • "))));
		}
	}

	private renderActivity(
		lines: string[],
		line: (s: string) => string,
		accent: (s: string) => string,
		muted: (s: string) => string,
		success: (s: string) => string,
		error: (s: string) => string,
		warning: (s: string) => string,
	): void {
		const active = this.runs.filter((run) => canCancelRun(run));
		lines.push(line(accent("Active runs")));
		if (active.length === 0) {
			lines.push(line(muted("No active background workflow runs.")));
		} else {
			for (const run of active.slice(0, 5)) {
				const lastLog = getRunLogs(run).slice(-1)[0];
				lines.push(
					line(
						`${accent("▶")} ${run.workflow} ${muted(run.runId)} ${formatElapsedMs(getRunElapsedMs(run))} agents:${run.agentCount} parallel:${formatParallelAgentsCompact(run)}${lastLog ? muted(` — ${renderSafeInline(lastLog.message)}`) : ""}`,
					),
				);
			}
		}

		lines.push(line(muted("")));
		lines.push(line(accent("Recent activity")));
		if (this.activity.length === 0) {
			lines.push(line(warning("No workflow activity yet.")));
			return;
		}
		const start = Math.max(0, Math.min(this.activityIndex - 7, this.activity.length - 14));
		const visible = this.activity.slice(start, start + 14);
		for (let i = 0; i < visible.length; i++) {
			const index = start + i;
			const entry = visible[i];
			const selected = index === this.activityIndex;
			const prefix = selected ? accent("› ") : "  ";
			const status =
				entry.state === "completed"
					? success("✓")
					: entry.state === "running"
						? accent("▶")
						: entry.state === "stale"
							? muted("?")
							: error(entry.state === "cancelled" ? "■" : "✗");
			const details =
				entry.details === undefined ? "" : muted(` — ${renderSafeInline(compactInline(entry.details, 120))}`);
			lines.push(
				line(
					`${prefix}${muted(entry.time.slice(11, 19))} ${status} ${entry.workflow} ${muted(entry.runId.slice(-12))} ${renderSafeInline(entry.message)}${details}`,
				),
			);
		}
		const selected = this.activity[this.activityIndex];
		if (selected) {
			lines.push(line(muted("")));
			lines.push(line(accent("Selected activity")));
			lines.push(line(`workflow: ${selected.workflow}`));
			lines.push(line(`run: ${selected.runId}`));
			lines.push(line(`time: ${selected.time}`));
			const run = this.runs.find((candidate) => candidate.runId === selected.runId);
			const actions = ["Enter/v opens full run timeline", "g graph"];
			if (run && canCancelRun(run)) actions.push("c/x cancel active");
			if (run && canRerunRun(run)) actions.push("r rerun (confirm)");
			if (run && !canCancelRun(run)) actions.push("d/delete run artifacts");
			lines.push(line(muted(actions.join(" • "))));
		}
	}
}
