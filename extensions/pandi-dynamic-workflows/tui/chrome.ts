/**
 * Chrome del WorkflowDashboard: overlay de ayuda, encabezado con tabs y banner de atajos.
 * El cuerpo de cada tab lo arma workflow-dashboard.ts después de renderDashboardChrome.
 */
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { WorkflowRunRecord } from "../types.js";
import { canRerunRun, type WorkflowMonitorModel } from "./collectors.js";
import type { WorkflowDashboardTab } from "./dashboard.js";
import { canCancelRun } from "./status-ui.js";

export type DashboardThemeFns = {
	line: (s: string) => string;
	accent: (s: string) => string;
	muted: (s: string) => string;
	success: (s: string) => string;
	error: (s: string) => string;
	warning: (s: string) => string;
	dim: (s: string) => string;
	border: (s: string) => string;
};

export type DashboardChromeHost = {
	tab: WorkflowDashboardTab;
	showHelp: boolean;
	theme: { fg: (token: string, s: string) => string };
	runs: WorkflowRunRecord[];
	selectedRun(): WorkflowRunRecord | undefined;
	selectedMonitor(): WorkflowMonitorModel | undefined;
	refreshStatus(muted: (s: string) => string, error: (s: string) => string): string;
};

export function renderDashboardHelp(
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

function buildDashboardThemeFns(w: number, theme: DashboardChromeHost["theme"]): DashboardThemeFns {
	// Jerarquía de colores (todos los tokens de tema semántico → adaptar a dark/light/auto; sin
	// colores en ningún lado): accent = primary/títulos/selección; success|warning|error = estado;
	// muted = etiquetas secundarias; dim = terciario (ids, paths, hints, chip labels);
	// border = reglas/separadores horizontales.
	const accent = (s: string) => theme.fg("accent", s);
	const muted = (s: string) => theme.fg("muted", s);
	const success = (s: string) => theme.fg("success", s);
	const error = (s: string) => theme.fg("error", s);
	const warning = (s: string) => theme.fg("warning", s);
	const dim = (s: string) => theme.fg("dim", s);
	const border = (s: string) => theme.fg("border", s);
	const line = (s: string) => truncateToWidth(s, w, "…");
	return { line, accent, muted, success, error, warning, dim, border };
}

/** Devuelve líneas de chrome (título/tabs/ayuda/borde). El caller agrega el cuerpo del tab. */
export function renderDashboardChrome(
	host: DashboardChromeHost,
	width: number,
): { lines: string[]; theme: DashboardThemeFns } | { helpOnly: string[] } {
	if (width <= 0) return { helpOnly: [] };
	const w = width;
	const themeFns = buildDashboardThemeFns(w, host.theme);
	const { line, accent, muted, error, border } = themeFns;
	if (host.showHelp) return { helpOnly: renderDashboardHelp(w, line, accent, muted) };
	const monitorTab = host.tab === "monitor" ? accent("[Monitor]") : muted(" Monitor ");
	const agentsTab = host.tab === "agents" ? accent("[Agents]") : muted(" Agents ");
	const sessionsTab = host.tab === "sessions" ? accent("[Sessions]") : muted(" Sessions ");
	const runsTab = host.tab === "runs" ? accent("[Runs]") : muted(" Runs ");
	const workflowTab = host.tab === "workflows" ? accent("[Workflows]") : muted(" Workflows ");
	const patternsTab = host.tab === "patterns" ? accent("[Patterns]") : muted(" Patterns ");
	const activityTab = host.tab === "activity" ? accent("[Activity]") : muted(" Activity ");
	const activeCount = host.runs.filter((run) => canCancelRun(run)).length;
	// Gate the action-bearing help on the SELECTED run so the banner never
	// advertises cancel/rerun/delete keys that the detail row won't honor.
	const selectedForActions = host.selectedRun();
	const selectedMonitorModel = host.tab === "monitor" ? host.selectedMonitor() : undefined;
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
		host.tab === "patterns"
			? "←→/Tab tabs • ↑↓ navigate catalog • Enter/n use pattern • q/esc close"
			: host.tab === "workflows"
				? "←→/Tab tabs • ↑↓ navigate • Enter/g graph • r run • d/delete workflow • q/esc close"
				: host.tab === "sessions"
					? "←→/Tab tabs • ↑↓ select Pi session • Enter switch • C cleanup • q/esc close"
					: host.tab === "monitor"
						? runActions("↑↓ agents • [ ] switch run • Enter/o detail (tabs) • v run • g graph")
						: host.tab === "agents"
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
		line(muted("? ayuda • ") + host.refreshStatus(muted, error) + muted(` • ${help}`)),
		line(border("─".repeat(Math.min(w, 120)))),
	];
	return { lines, theme: themeFns };
}
