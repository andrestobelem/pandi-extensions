/**
 * WorkflowDashboard — the main /workflow TUI dashboard class (tabbed monitor of runs,
 * agents, sessions, runs, workflows, patterns, and activity) plus its tab constant,
 * window/reselect helpers, and the DashboardSelection result type.
 *
 * Pure UI over already-derived models; the collectors and openWorkflowDashboard stay in
 * index.ts. Fully-deferred cycle: the class reads canCancelRun/canRerunRun/compactInline
 * only inside methods; runtime constants come from runtime-constants.ts, and index.ts imports the class
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
import { getPatternUseCases, WORKFLOW_PATTERN_CATALOG } from "./pattern-scaffolds.js";
import type { PiSessionModel } from "./pi-session.js";
import { compactInline, formatElapsedMs } from "./presentation.js";
import { padRightVisible, renderMeter, renderSafeInline } from "./render-utils.js";
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
import { PI_SESSION_HEARTBEAT_MS } from "./runtime-constants.js";
import type { AgentMonitorModel, WorkflowDefinition, WorkflowRunRecord } from "./types.js";

const WORKFLOW_DASHBOARD_TABS = ["monitor", "agents", "sessions", "runs", "workflows", "patterns", "activity"] as const;
export type WorkflowDashboardTab = (typeof WORKFLOW_DASHBOARD_TABS)[number];

// Fuente única de verdad para la guía "¿cómo creo la primera ejecución?" así que
// toda lista vacía con ejecuciones (Monitor, Runs, Agents, Activity) da
// al usuario primerizo el comando exacto en lugar de una línea muerta "nada aquí".
const START_WORKFLOW_HINT = "Iniciá uno con /workflow start <name> {json} o dynamic_workflow action=start.";

// Mantén el cursor en el mismo elemento cuando una lista se reconstruye/reordena debajo
// (las listas están ordenadas por mtime y se actualizan cada 1.5s, así que un índice fijo
// reorientaría silenciosamente acciones destructivas). Vuelve a la posición limitada cuando
// el elemento previamente seleccionado se ha ido.
// Sufijo compacto "mostrando a-b/total" para listas ventaneadas; vacío cuando toda la
// lista cabe, para que los usuarios sepan que una lista se desplazó y dónde se sienta la ventana.
function windowLabel(total: number, start: number, count: number): string {
	if (total <= count) return "";
	const end = Math.min(total, start + count);
	return ` · ${start + 1}–${end}/${total}`;
}

// Ventana de scroll: `before` es el margen antes del elemento seleccionado; `windowSize` es el
// total visible (típicamente before*2). Clampa el inicio entre 0 y length-windowSize.
function windowStart(selectedIndex: number, length: number, before: number, windowSize: number): number {
	return Math.max(0, Math.min(selectedIndex - before, length - windowSize));
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
	monitorRunIndex: number;
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
		private readonly workflows: WorkflowDefinition[],
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
		// Retroceso se excluye intencionalmente: se lee como "volver/borrar" en casi
		// cada TUI, así que vincularlo a una eliminación destructiva fue un error sorprendente.
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
			// La superposición de ayuda es una pista modal: cualquier tecla la descarta.
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
			if (this.tab === "sessions") {
				const session = this.piSessions[this.sessionIndex];
				if (session) this.done({ type: "switchSession", session });
				return;
			}
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
			// Page/Home/End (y vim G = último) saltan dentro de la lista activa, reflejando la vista de agente en vivo.
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
		if ((data === "[" || data === "]") && (this.tab === "runs" || this.tab === "activity")) {
			// Refleja el ciclado [ ] de ejecución del Monitor en las listas planas: salta la selección al
			// siguiente/anterior elemento en ejecución para que una larga lista Runs/Activity se pueda clasificar al
			// ejecuciones en progreso con una tecla.
			this.jumpToActiveRun(data === "]" ? 1 : -1);
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
			else if (data === "C") this.done({ type: "cleanup", cleanupTarget: "sessions" });
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

	// Fuente única de verdad para los atajos de acción de ejecución compartidos por cada
	// pestaña con ejecuciones (monitor, agents, runs, activity): salida de agente Enter/o,
	// vista de ejecución v, gráfico g, cancelar c/x (limitado), reejecutar r (limitado), eliminar d/Del.
	// `agent` solo se pasa donde una fila de sub-agente es seleccionable (monitor/agents);
	// sin él Enter/o cae a la vista de ejecución, coincidiendo con el comportamiento anterior.
	// Extraído de tres ramas byte-idénticas para evitar que se desvíen.
	private handleRunSelectionInput(data: string, run: WorkflowRunRecord, agent?: AgentMonitorModel): void {
		if ((matchesKey(data, Key.enter) || data === "o") && agent) this.done({ type: "agent", run, agent });
		else if (matchesKey(data, Key.enter) || data === "v") this.done({ type: "view", run });
		else if (data === "g") this.done({ type: "graph", run });
		else if ((data === "c" || data === "x") && canCancelRun(run)) this.done({ type: "cancel", run });
		else if (data === "r" && canRerunRun(run)) this.done({ type: "rerun", run });
		else if (data === "C") this.done({ type: "cleanup", cleanupTarget: "runs" });
		else if (this.isDeleteInput(data)) this.done({ type: "deleteRun", run });
	}

	// Salta la selección al siguiente agente fallido (adelante, envuelto). Convierte el
	// contador failed:N en triaje de una tecla para grandes fan-outs.
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

	// Salta la selección a la siguiente/anterior ejecución RUNNING (pestaña Runs) o entrada de actividad en ejecución
	// (pestaña Activity), envuelto. Convierte el glifo ▶ running en triaje de una tecla en la
	// listas, de la misma manera que `f` salta al siguiente agente fallido. No-op cuando nada se ejecuta.
	private jumpToActiveRun(delta: number): void {
		if (this.tab === "runs") {
			const n = this.runs.length;
			for (let step = 1; step <= n; step++) {
				const index = (((this.runIndex + delta * step) % n) + n) % n;
				if (getRunState(this.runs[index]!) === "running") {
					this.runIndex = index;
					this.requestRender();
					return;
				}
			}
		} else if (this.tab === "activity") {
			const n = this.activity.length;
			for (let step = 1; step <= n; step++) {
				const index = (((this.activityIndex + delta * step) % n) + n) % n;
				if (this.activity[index]?.state === "running") {
					this.activityIndex = index;
					this.requestRender();
					return;
				}
			}
		}
	}

	// Cicla la ejecución activa enfocada en el Monitor (master-detail sobre todas las ejecuciones activas).
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
			line(accent("Pi Dynamic Workflows — ayuda de teclado")),
			line(muted("Presioná cualquier tecla para cerrar")),
			line(muted("─".repeat(Math.min(w, 120)))),
			line(accent("Tabs")),
			line("  Tab / ← / → cambia de tab · Shift+Tab anterior"),
			line("  m Monitor · A Agents · a Activity · s Sessions · w Workflows · p Patterns · R Runs"),
			line(accent("Navegación")),
			line("  ↑ ↓ / j k mueve · PgUp / PgDn página · Home / End / G primero / último"),
			line("  [ ] run activo — Monitor: rota el foco · Runs/Activity: salta al running sig./ant."),
			line(accent("Acciones")),
			line("  Enter / o detalle del agente — sub-tabs: Card · Prompt · Graph · Output · Definition · Run (←→/1-6)"),
			line("  v vista de run · g graph"),
			line("  f siguiente agente failed (tab Agents)"),
			line("  c / x cancela el activo · r rerun (confirmación) · d / Del borra (confirmación)"),
			line("  C cleanup (Runs: runs terminales · Sessions: archivos de sesión stale) — confirmación"),
			line("  Patterns: Enter / n / u usa el pattern · Workflows: Enter / g graph, r run, d delete"),
			line("  Sessions: Enter cambia de sesión · C cleanup de archivos de sesión stale"),
			line(accent("Otros")),
			line("  ? alterna esta ayuda · q / Esc cierra el dashboard"),
		];
	}

	render(width: number): string[] {
		if (width <= 0) return [];
		const w = width;
		// Jerarquía de colores (todos los tokens de tema semántico → adaptar a dark/light/auto; sin
		// colores en ningún lado): accent = primary/títulos/selección; success|warning|error = estado;
		// muted = etiquetas secundarias; dim = terciario (ids, paths, hints, chip labels);
		// border = reglas/separadores horizontales.
		const accent = (s: string) => this.theme.fg("accent", s);
		const muted = (s: string) => this.theme.fg("muted", s);
		const success = (s: string) => this.theme.fg("success", s);
		const error = (s: string) => this.theme.fg("error", s);
		const warning = (s: string) => this.theme.fg("warning", s);
		const dim = (s: string) => this.theme.fg("dim", s);
		const border = (s: string) => this.theme.fg("border", s);
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
			parts.push("C cleanup");
			parts.push("q/esc close");
			return parts.join(" • ");
		};
		const help =
			this.tab === "patterns"
				? "←→/Tab tabs • ↑↓ navigate catalog • Enter/n use pattern • q/esc close"
				: this.tab === "workflows"
					? "←→/Tab tabs • ↑↓ navigate • Enter/g graph • r run • d/delete workflow • q/esc close"
					: this.tab === "sessions"
						? "←→/Tab tabs • ↑↓ select Pi session • Enter switch • C cleanup • q/esc close"
						: this.tab === "monitor"
							? runActions("↑↓ agents • [ ] switch run • Enter/o detail (tabs) • v run • g graph")
							: this.tab === "agents"
								? runActions("↑↓ select agent • f next failed • Enter/o detail (tabs) • v run • g graph")
								: runActions("↑↓ navigate • [ ] next running • Enter/v view • g graph");
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
			line(muted("? ayuda • ") + this.refreshStatus(muted, error) + muted(` • ${help}`)),
			line(border("─".repeat(Math.min(w, 120)))),
		];

		if (this.tab === "monitor") this.renderMonitor(lines, line, accent, muted, success, error, warning, dim);
		else if (this.tab === "agents") this.renderAgents(lines, line, accent, muted, success, error, warning, dim);
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
		dim: (s: string) => string,
	): void {
		// Línea en blanco + subtítulo dim: agrupa el bloque de etiqueta densa en secciones legibles.
		const section = (caption: string) => {
			lines.push(line(""));
			lines.push(line(dim(caption)));
		};
		const model = this.selectedMonitor();
		if (!model) {
			lines.push(line(warning("No se encontraron workflow runs.")));
			lines.push(line(muted(START_WORKFLOW_HINT)));
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
				const rowMeter = renderMeter(m.agentsStarted > 0 ? m.agentsDone / m.agentsStarted : 0, 8, {
					fill: success,
					empty: muted,
				});
				lines.push(
					line(
						`${prefix}${glyph} ${m.workflow} ${muted(m.runId)} ${rowMeter} ${m.agentsDone}/${m.agentsStarted} ${muted(`parallel:${parallel}`)}`,
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

		section("Progress");
		const progressFrac = model.agentsStarted > 0 ? model.agentsDone / model.agentsStarted : 0;
		const progressMeter = renderMeter(progressFrac, 14, { fill: success, empty: muted });
		label(
			"agents",
			`${model.agentsDone}/${model.agentsStarted} done/started ${progressMeter} ${muted(`${Math.round(progressFrac * 100)}%`)}`,
		);
		const hasConcurrency = !!(model.agentConcurrency && model.agentConcurrency > 0);
		const parallelText = hasConcurrency
			? `${model.parallelAgents}/${model.agentConcurrency}`
			: `${model.parallelAgents}`;
		const utilMeter = hasConcurrency
			? ` ${renderMeter(model.parallelAgents / (model.agentConcurrency as number), 14, { fill: accent, empty: muted })}`
			: "";
		label(
			"parallel",
			`${parallelText} running${utilMeter}${model.peakParallelAgents === undefined ? "" : ` • peak:${model.peakParallelAgents}`}`,
		);
		label("bash", `${model.bashDone} done`);
		label("artifacts", String(model.artifactCount));

		section("Location");
		label("run", model.runId);
		label("runDir", dim(model.runDir));

		section("Activity");
		const last = model.lastLog
			? `${model.lastLog.time.slice(11, 19)} ${renderSafeInline(model.lastLog.message)}`
			: "No logs recorded yet.";
		label("last", last);
		if (model.run.error) label("error", error(renderSafeInline(compactInline(model.run.error, 200))));
		// Action hints live on the gated header banner (render line 1); no redundant footer here.
		this.renderMonitorAgents(lines, line, model, accent, muted, success, error, warning, dim);
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

	/**
	 * Render the shared "Selected agent" detail block used by both the Monitor and
	 * Agents tabs. The two callers only differ in: optional header lines
	 * (workflow/run/parallel), whether the `state:` line includes the schema
	 * suffix, and the `compactInline` width for prompt preview / output.
	 */
	private renderSelectedAgentDetail(
		lines: string[],
		line: (s: string) => string,
		agent: AgentMonitorModel,
		accent: (s: string) => string,
		muted: (s: string) => string,
		success: (s: string) => string,
		warning: (s: string) => string,
		dim: (s: string) => string,
		options: { headerLines?: string[]; includeSchemaInState: boolean; compactWidth: number },
	): void {
		lines.push(line(muted("")));
		lines.push(line(accent("Selected agent")));
		for (const header of options.headerLines ?? []) lines.push(line(header));
		lines.push(
			line(`agent: #${agent.id} ${formatAgentPhase(agent) ? `${formatAgentPhase(agent)} ` : ""}${agent.name}`),
		);
		const elapsedMs = getAgentElapsedMs(agent);
		const schemaSuffix = options.includeSchemaInState
			? `${agent.schemaOk === undefined ? "" : ` • schema ${agent.schemaOk ? "ok" : "bad"}`}`
			: "";
		lines.push(
			line(
				`state: ${renderSafeInline(agent.state)}${elapsedMs === undefined ? "" : ` • ${formatElapsedMs(elapsedMs)}`}${agent.code === undefined ? "" : ` • code ${agent.code}`}${schemaSuffix}`,
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
		lines.push(line(""));
		lines.push(line(dim("config")));
		lines.push(
			line(
				`model: ${agent.model ? renderSafeInline(agent.model) : "default"} • effort: ${agent.thinking ? renderSafeInline(agent.thinking) : "default"}`,
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
		if (
			agent.promptPreview ||
			agent.output !== undefined ||
			agent.outputEmpty ||
			agent.outputTruncated ||
			agent.stdoutTruncated
		) {
			lines.push(line(""));
			lines.push(line(dim("i/o")));
		}
		if (agent.promptPreview)
			lines.push(
				line(`prompt preview: ${renderSafeInline(compactInline(agent.promptPreview, options.compactWidth))}`),
			);
		if (agent.output !== undefined)
			lines.push(line(`output: ${renderSafeInline(compactInline(agent.output, options.compactWidth))}`));
		if (agent.outputEmpty) lines.push(line(warning("integrity: empty-output")));
		if (agent.outputTruncated)
			lines.push(
				line(
					warning(
						`integrity: output:truncated${agent.outputChars === undefined ? "" : ` (${agent.outputChars} chars)`}`,
					),
				),
			);
		if (agent.stdoutTruncated)
			lines.push(
				line(
					warning(
						`integrity: stdout:truncated${agent.stdoutChars === undefined ? "" : ` (${agent.stdoutChars} chars)`}`,
					),
				),
			);
	}

	// Common per-row chip suffix (`prompt schema tools skills extensions keys`)
	// shared byte-for-byte by the Monitor and Agents tabs. Callers keep their own
	// prefix/state/elapsed and the tab-specific segments (Monitor's `code:` chip,
	// Agents' `— <workflow> <runId>` segment) outside this helper.
	private renderAgentRowMeta(
		agent: AgentMonitorModel,
		muted: (s: string) => string,
		success: (s: string) => string,
		error: (s: string) => string,
		warning: (s: string) => string,
		dim: (s: string) => string,
	): string {
		// Chips unidos por un divisor ` · ` para que la fila respire; las ETIQUETAS de chip usan dim para que
		// los chips que llevan estado (prompt✓ / schema:bad / missing) sigan siendo los que atraen la vista.
		const chips: string[] = [agent.promptAvailable ? success("prompt✓") : warning("prompt?")];
		if (agent.schemaOk !== undefined) chips.push(agent.schemaOk ? muted("schema:ok") : error("schema:bad"));
		if (agent.outputEmpty) chips.push(error("empty-output"));
		if (agent.outputTruncated) chips.push(warning("output:truncated"));
		if (agent.stdoutTruncated) chips.push(warning("stdout:truncated"));
		// chips de modelo/esfuerzo: id de modelo corto (último segmento de ruta) para mantener la fila compacta;
		// omitido completamente cuando se desconoce (ejecuciones registradas antes de que existieran estos campos).
		if (agent.model) chips.push(dim(`model:${renderSafeInline(agent.model.split("/").pop() ?? agent.model)}`));
		if (agent.thinking) chips.push(dim(`effort:${renderSafeInline(agent.thinking)}`));
		chips.push(dim(`tools:${agent.tools?.length ? agent.tools.length : "default"}`));
		chips.push(
			dim(
				`skills:${agent.skills?.length ? agent.skills.length : agent.includeSkills === false ? "off" : "default"}`,
			),
		);
		chips.push(
			dim(`ext:${agent.extensions?.length ? agent.extensions.length : agent.includeExtensions ? "default" : "off"}`),
		);
		chips.push(dim(`keys:${agent.keys?.length ? agent.keys.length : agent.isolatedEnv ? "none" : "default"}`));
		if (agent.missingKeys?.length) chips.push(warning(`missing:${agent.missingKeys.length}`));
		return chips.join(" · ");
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
		dim: (s: string) => string,
	): void {
		if (model.agents.length === 0) return;
		lines.push(line(muted("")));
		const start = windowStart(this.monitorAgentIndex, model.agents.length, 6, 12);
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
			const meta = this.renderAgentRowMeta(agent, muted, success, error, warning, dim);
			lines.push(
				line(
					`${prefix}${state} #${agent.id}${phase ? ` ${accent(phase)}` : ""} ${renderSafeInline(agent.name)} ${muted(elapsed)}${code} ${meta}`,
				),
			);
		}
		const selected = this.selectedAgent();
		if (!selected) return;
		this.renderSelectedAgentDetail(lines, line, selected, accent, muted, success, warning, dim, {
			includeSchemaInState: false,
			compactWidth: 220,
		});
	}

	private renderAgents(
		lines: string[],
		line: (s: string) => string,
		accent: (s: string) => string,
		muted: (s: string) => string,
		success: (s: string) => string,
		error: (s: string) => string,
		warning: (s: string) => string,
		dim: (s: string) => string,
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
			lines.push(line(muted(START_WORKFLOW_HINT)));
			return;
		}
		const running = this.agentEntries.filter((entry) => entry.agent.state === "running").length;
		const failed = this.agentEntries.filter((entry) => entry.agent.state === "failed").length;
		const cached = this.agentEntries.filter((entry) => entry.agent.state === "cached").length;
		const activeRuns = this.runs.filter((run) => getRunState(run) === "running");
		const parallelNow = activeRuns.reduce((sum, run) => sum + getRunParallelAgents(run), 0);
		const parallelLimit = activeRuns.reduce((sum, run) => sum + (getRunAgentConcurrency(run) ?? 0), 0);
		const parallelText = parallelLimit > 0 ? `${parallelNow}/${parallelLimit}` : String(parallelNow);
		const start = windowStart(this.agentIndex, this.agentEntries.length, 7, 14);
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
			const meta = this.renderAgentRowMeta(entry.agent, muted, success, error, warning, dim);
			lines.push(
				line(
					`${prefix}${state} #${entry.agent.id}${phase ? ` ${accent(phase)}` : ""} ${renderSafeInline(entry.agent.name)} ${muted(`— ${entry.run.workflow} ${entry.run.runId.slice(-12)}`)} ${muted(elapsed)} ${meta}`,
				),
			);
		}
		const selected = this.selectedAgentEntry();
		if (!selected) return;
		const agent = selected.agent;
		const run = selected.run;
		this.renderSelectedAgentDetail(lines, line, agent, accent, muted, success, warning, dim, {
			headerLines: [`workflow: ${run.workflow}`, `run: ${run.runId}`, `parallel: ${formatParallelAgents(run)}`],
			includeSchemaInState: true,
			compactWidth: 260,
		});
		// Action hints live on the gated header banner (render line 1); no redundant footer here.
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
		const start = windowStart(this.sessionIndex, this.piSessions.length, 6, 12);
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
		const start = windowStart(this.workflowIndex, this.workflows.length, 6, 12);
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
		const start = windowStart(this.patternIndex, WORKFLOW_PATTERN_CATALOG.length, 6, 12);
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
			lines.push(line(muted("No se encontraron workflow runs.")));
			lines.push(line(muted(START_WORKFLOW_HINT)));
			return;
		}
		const start = windowStart(this.runIndex, this.runs.length, 6, 12);
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
			lines.push(line(`dir: ${this.theme.fg("dim", selected.runDir)}`));
			if (selected.error)
				lines.push(line(`${accent("error")}: ${error(renderSafeInline(compactInline(selected.error, 200)))}`));
			for (const logEntry of getRunLogs(selected).slice(-5))
				lines.push(line(`${muted(logEntry.time.slice(11, 19))} ${renderSafeInline(logEntry.message)}`));
			// Action verbs live on the gated header banner; only the unique resume COMMAND
			// (not shown in the header) earns a footer line here.
			if (isResumableState(getRunState(selected)))
				lines.push(line(this.theme.fg("dim", `/workflow resume ${selected.runId}`)));
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
			lines.push(line(muted(START_WORKFLOW_HINT)));
			return;
		}
		const start = windowStart(this.activityIndex, this.activity.length, 7, 14);
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
			// Action hints live on the gated header banner (render line 1); no redundant footer here.
		}
	}
}
