/**
 * Teclado y navegación del WorkflowDashboard — atajos por tab, listas y acciones de run.
 * El host expone estado mutable y helpers; la clase del dashboard delega handleInput acá.
 */
import { Key, matchesKey } from "@earendil-works/pi-tui";
import { WORKFLOW_PATTERN_CATALOG } from "../lib/pattern-catalog.js";
import type { PiSessionModel } from "../pi-session.js";
import { getRunState } from "../runtime/index.js";
import type { AgentMonitorModel, WorkflowDefinition, WorkflowRunRecord } from "../types.js";
import {
	canRerunRun,
	type WorkflowActivityEntry,
	type WorkflowAgentEntry,
	type WorkflowDashboardResult,
	type WorkflowMonitorModel,
} from "./collectors.js";
import type { WorkflowDashboardTab } from "./dashboard.js";
import { canCancelRun } from "./status-ui.js";

export interface DashboardInputHost {
	tab: WorkflowDashboardTab;
	showHelp: boolean;
	workflowIndex: number;
	runIndex: number;
	activityIndex: number;
	sessionIndex: number;
	agentIndex: number;
	monitorAgentIndex: number;
	monitorRunIndex: number;
	patternIndex: number;
	readonly sessionPicker: boolean;
	readonly workflows: readonly WorkflowDefinition[];
	readonly runs: readonly WorkflowRunRecord[];
	readonly activity: readonly WorkflowActivityEntry[];
	readonly piSessions: readonly PiSessionModel[];
	readonly monitorModels: readonly WorkflowMonitorModel[];
	readonly agentEntries: readonly WorkflowAgentEntry[];
	selectedMonitor(): WorkflowMonitorModel | undefined;
	selectedRun(): WorkflowRunRecord | undefined;
	selectedAgent(): AgentMonitorModel | undefined;
	moveTab(delta: number): void;
	requestRender(): void;
	done(result: WorkflowDashboardResult | null): void;
	activeListLength(): number;
	getActiveIndex(): number;
	setActiveIndex(value: number): void;
}

export function isDeleteInput(data: string): boolean {
	// Retroceso se excluye intencionalmente: se lee como "volver/borrar" en casi
	// cada TUI, así que vincularlo a una eliminación destructiva fue un error sorprendente.
	return data === "d" || matchesKey(data, Key.delete);
}

export function handleDashboardInput(host: DashboardInputHost, data: string): void {
	if (host.showHelp) {
		// La superposición de ayuda es una pista modal: cualquier tecla la descarta.
		host.showHelp = false;
		host.requestRender();
		return;
	}
	if (matchesKey(data, Key.escape) || data === "q") {
		host.done(null);
		return;
	}
	if (data === "?") {
		host.showHelp = true;
		host.requestRender();
		return;
	}
	if (matchesKey(data, "shift+tab")) {
		host.moveTab(-1);
		return;
	}
	if (matchesKey(data, Key.tab)) {
		host.moveTab(1);
		return;
	}
	if (matchesKey(data, Key.left)) {
		host.moveTab(-1);
		return;
	}
	if (matchesKey(data, Key.right)) {
		if (host.tab === "sessions" && host.sessionPicker) {
			const session = host.piSessions[host.sessionIndex];
			if (session) host.done({ type: "switchSession", session });
			return;
		}
		host.moveTab(1);
		return;
	}
	if (data === "m") {
		host.tab = "monitor";
		host.requestRender();
		return;
	}
	if (data === "A" || (data === "n" && host.tab !== "patterns")) {
		host.tab = "agents";
		host.requestRender();
		return;
	}
	if (data === "a") {
		host.tab = "activity";
		host.requestRender();
		return;
	}
	if (data === "s") {
		host.tab = "sessions";
		host.requestRender();
		return;
	}
	if (data === "w") {
		host.tab = "workflows";
		host.requestRender();
		return;
	}
	if (data === "p") {
		host.tab = "patterns";
		host.requestRender();
		return;
	}
	if (data === "R") {
		host.tab = "runs";
		host.requestRender();
		return;
	}
	if (matchesKey(data, Key.up) || data === "k") {
		if (host.tab === "monitor" && (host.selectedMonitor()?.agents.length ?? 0) > 0)
			host.monitorAgentIndex = Math.max(0, host.monitorAgentIndex - 1);
		else if (host.tab === "agents") host.agentIndex = Math.max(0, host.agentIndex - 1);
		else if (host.tab === "workflows") host.workflowIndex = Math.max(0, host.workflowIndex - 1);
		else if (host.tab === "patterns") host.patternIndex = Math.max(0, host.patternIndex - 1);
		else if (host.tab === "sessions") host.sessionIndex = Math.max(0, host.sessionIndex - 1);
		else if (host.tab === "runs") host.runIndex = Math.max(0, host.runIndex - 1);
		else if (host.tab === "activity") host.activityIndex = Math.max(0, host.activityIndex - 1);
		host.requestRender();
		return;
	}
	if (matchesKey(data, Key.down) || data === "j") {
		if (host.tab === "monitor" && (host.selectedMonitor()?.agents.length ?? 0) > 0)
			host.monitorAgentIndex = Math.min(
				Math.max(0, (host.selectedMonitor()?.agents.length ?? 1) - 1),
				host.monitorAgentIndex + 1,
			);
		else if (host.tab === "agents")
			host.agentIndex = Math.min(Math.max(0, host.agentEntries.length - 1), host.agentIndex + 1);
		else if (host.tab === "workflows")
			host.workflowIndex = Math.min(Math.max(0, host.workflows.length - 1), host.workflowIndex + 1);
		else if (host.tab === "patterns")
			host.patternIndex = Math.min(Math.max(0, WORKFLOW_PATTERN_CATALOG.length - 1), host.patternIndex + 1);
		else if (host.tab === "sessions")
			host.sessionIndex = Math.min(Math.max(0, host.piSessions.length - 1), host.sessionIndex + 1);
		else if (host.tab === "runs") host.runIndex = Math.min(Math.max(0, host.runs.length - 1), host.runIndex + 1);
		else if (host.tab === "activity")
			host.activityIndex = Math.min(Math.max(0, host.activity.length - 1), host.activityIndex + 1);
		host.requestRender();
		return;
	}
	if (
		matchesKey(data, Key.pageUp) ||
		matchesKey(data, Key.pageDown) ||
		matchesKey(data, Key.home) ||
		matchesKey(data, Key.end) ||
		data === "G"
	) {
		// Page/Home/End (y vim G = último) saltan dentro de la lista activa, reflejando la vista de agente en vivo.
		const page = 10;
		if (host.activeListLength() > 0) {
			if (matchesKey(data, Key.pageUp)) host.setActiveIndex(host.getActiveIndex() - page);
			else if (matchesKey(data, Key.pageDown)) host.setActiveIndex(host.getActiveIndex() + page);
			else if (matchesKey(data, Key.home)) host.setActiveIndex(0);
			else host.setActiveIndex(host.activeListLength() - 1);
			host.requestRender();
		}
		return;
	}
	if ((data === "[" || data === "]") && (host.tab === "runs" || host.tab === "activity")) {
		// Refleja el ciclado [ ] de ejecución del Monitor en las listas planas: salta la selección al
		// siguiente/anterior elemento en ejecución para que una larga lista Runs/Activity se pueda clasificar al
		// ejecuciones en progreso con una tecla.
		jumpToActiveRun(host, data === "]" ? 1 : -1);
		return;
	}
	if (host.tab === "workflows") {
		const workflow = host.workflows[host.workflowIndex];
		if (!workflow) return;
		if (matchesKey(data, Key.enter) || data === "g") host.done({ type: "graph", workflow });
		else if (data === "r") host.done({ type: "run", workflow });
		else if (isDeleteInput(data)) host.done({ type: "deleteWorkflow", workflow });
		return;
	}
	if (host.tab === "patterns") {
		const pattern = WORKFLOW_PATTERN_CATALOG[host.patternIndex];
		if (!pattern) return;
		if (matchesKey(data, Key.enter) || data === "n" || data === "u") host.done({ type: "newPattern", pattern });
		return;
	}
	if (host.tab === "sessions") {
		const session = host.piSessions[host.sessionIndex];
		if (!session) return;
		if (matchesKey(data, Key.enter)) host.done({ type: "switchSession", session });
		else if (data === "C") host.done({ type: "cleanup", cleanupTarget: "sessions" });
		return;
	}
	const run = host.selectedRun();
	if (!run) return;
	if (host.tab === "monitor") {
		if (data === "[" || data === "]") {
			cycleMonitorRun(host, data === "]" ? 1 : -1);
			return;
		}
		handleRunSelectionInput(host, data, run, host.selectedAgent());
		return;
	}
	if (host.tab === "agents") {
		if (data === "f") {
			jumpToNextFailedAgent(host);
			return;
		}
		handleRunSelectionInput(host, data, run, host.selectedAgent());
		return;
	}
	handleRunSelectionInput(host, data, run);
}

// Fuente única de verdad para los atajos de acción de ejecución compartidos por cada
// pestaña con ejecuciones (monitor, agents, runs, activity): salida de agente Enter/o,
// vista de ejecución v, gráfico g, cancelar c/x (limitado), reejecutar r (limitado), eliminar d/Del.
// `agent` solo se pasa donde una fila de sub-agente es seleccionable (monitor/agents);
// sin él Enter/o cae a la vista de ejecución, coincidiendo con el comportamiento anterior.
// Extraído de tres ramas byte-idénticas para evitar que se desvíen.
export function handleRunSelectionInput(
	host: DashboardInputHost,
	data: string,
	run: WorkflowRunRecord,
	agent?: AgentMonitorModel,
): void {
	if ((matchesKey(data, Key.enter) || data === "o") && agent) host.done({ type: "agent", run, agent });
	else if (matchesKey(data, Key.enter) || data === "v") host.done({ type: "view", run });
	else if (data === "g") host.done({ type: "graph", run });
	else if ((data === "c" || data === "x") && canCancelRun(run)) host.done({ type: "cancel", run });
	else if (data === "r" && canRerunRun(run)) host.done({ type: "rerun", run });
	else if (data === "C") host.done({ type: "cleanup", cleanupTarget: "runs" });
	else if (isDeleteInput(data)) host.done({ type: "deleteRun", run });
}

// Salta la selección al siguiente agente fallido (adelante, envuelto). Convierte el
// contador failed:N en triaje de una tecla para grandes fan-outs.
export function jumpToNextFailedAgent(host: DashboardInputHost): void {
	const n = host.agentEntries.length;
	if (n === 0) return;
	for (let step = 1; step <= n; step++) {
		const index = (host.agentIndex + step) % n;
		if (host.agentEntries[index]?.agent.state === "failed") {
			host.agentIndex = index;
			host.requestRender();
			return;
		}
	}
}

// Salta la selección a la siguiente/anterior ejecución RUNNING (pestaña Runs) o entrada de actividad en ejecución
// (pestaña Activity), envuelto. Convierte el glifo ▶ running en triaje de una tecla en la
// listas, de la misma manera que `f` salta al siguiente agente fallido. No-op cuando nada se ejecuta.
export function jumpToActiveRun(host: DashboardInputHost, delta: number): void {
	if (host.tab === "runs") {
		const n = host.runs.length;
		for (let step = 1; step <= n; step++) {
			const index = (((host.runIndex + delta * step) % n) + n) % n;
			if (getRunState(host.runs[index]!) === "running") {
				host.runIndex = index;
				host.requestRender();
				return;
			}
		}
	} else if (host.tab === "activity") {
		const n = host.activity.length;
		for (let step = 1; step <= n; step++) {
			const index = (((host.activityIndex + delta * step) % n) + n) % n;
			if (host.activity[index]?.state === "running") {
				host.activityIndex = index;
				host.requestRender();
				return;
			}
		}
	}
}

// Cicla la ejecución activa enfocada en el Monitor (master-detail sobre todas las ejecuciones activas).
export function cycleMonitorRun(host: DashboardInputHost, delta: number): void {
	const n = host.monitorModels.length;
	if (n <= 1) return;
	host.monitorRunIndex = (host.monitorRunIndex + delta + n) % n;
	host.monitorAgentIndex = 0;
	host.requestRender();
}
