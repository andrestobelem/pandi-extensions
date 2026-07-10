/**
 * Pure tab-view renderers for WorkflowDashboard — window helpers, formatter contracts,
 * and the patterns/workflows/sessions/runs/activity list+detail views. No class state;
 * the dashboard class wires theme formatters and pushes returned lines.
 */

import type { PiSessionModel } from "../pi-session.js";
import { compactInline, formatElapsedMs } from "../presentation.js";
import {
	formatParallelAgents,
	formatParallelAgentsCompact,
	getRunCachedCalls,
	getRunElapsedMs,
	getRunLogs,
	getRunState,
	getRunStatusLabel,
	isResumableState,
	PI_SESSION_HEARTBEAT_MS,
} from "../runtime/index.js";
import { getPatternUseCases, WORKFLOW_PATTERN_CATALOG } from "../surface/index.js";
import type { WorkflowDefinition, WorkflowRunRecord } from "../types.js";
import type { WorkflowActivityEntry } from "./collectors.js";
import { renderSafeInline } from "./render-utils.js";
import { canCancelRun } from "./status-ui.js";

// Fuente única de verdad para la guía "¿cómo creo la primera ejecución?" así que
// toda lista vacía con ejecuciones (Monitor, Runs, Agents, Activity) da
// al usuario primerizo el comando exacto en lugar de una línea muerta "nada aquí".
export const START_WORKFLOW_HINT = "Iniciá uno con /workflow start <name> {json} o dynamic_workflow action=start.";

// Sufijo compacto "mostrando a-b/total" para listas ventaneadas; vacío cuando toda la
// lista cabe, para que los usuarios sepan que una lista se desplazó y dónde se sienta la ventana.
export function windowLabel(total: number, start: number, count: number): string {
	if (total <= count) return "";
	const end = Math.min(total, start + count);
	return ` · ${start + 1}–${end}/${total}`;
}

// Ventana de scroll: `before` es el margen antes del elemento seleccionado; `windowSize` es el
// total visible (típicamente before*2). Clampa el inicio entre 0 y length-windowSize.
export function windowStart(selectedIndex: number, length: number, before: number, windowSize: number): number {
	return Math.max(0, Math.min(selectedIndex - before, length - windowSize));
}

interface DashboardListViewFormatters {
	line: (s: string) => string;
	accent: (s: string) => string;
	muted: (s: string) => string;
	warning: (s: string) => string;
}

interface DashboardStatusListViewFormatters extends DashboardListViewFormatters {
	success: (s: string) => string;
}

interface DashboardRunViewFormatters {
	line: (s: string) => string;
	accent: (s: string) => string;
	muted: (s: string) => string;
	success: (s: string) => string;
	error: (s: string) => string;
	dim: (s: string) => string;
}

interface DashboardActivityViewFormatters extends DashboardStatusListViewFormatters {
	error: (s: string) => string;
}

export function renderPatternsView(
	patternIndex: number,
	{ line, accent, muted, warning }: DashboardListViewFormatters,
): string[] {
	const lines: string[] = [];
	if (WORKFLOW_PATTERN_CATALOG.length === 0) {
		lines.push(line(warning("No workflow patterns registered.")));
		return lines;
	}
	lines.push(
		line(
			`${accent("Pattern catalog")} ${muted(`(${WORKFLOW_PATTERN_CATALOG.length})`)} ${muted("• choose a scaffold, then edit before saving")}`,
		),
	);
	const start = windowStart(patternIndex, WORKFLOW_PATTERN_CATALOG.length, 6, 12);
	const visible = WORKFLOW_PATTERN_CATALOG.slice(start, start + 12);
	for (let i = 0; i < visible.length; i++) {
		const index = start + i;
		const pattern = visible[i];
		const selected = index === patternIndex;
		const prefix = selected ? accent("› ") : "  ";
		lines.push(
			line(`${prefix}${pattern.key} ${muted("—")} ${pattern.title} ${muted(`(${pattern.primitives.join(" + ")})`)}`),
		);
	}
	const selected = WORKFLOW_PATTERN_CATALOG[patternIndex];
	if (!selected) return lines;
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
	return lines;
}

export function renderWorkflowsView(
	workflows: WorkflowDefinition[],
	workflowIndex: number,
	{ line, accent, muted, warning }: DashboardListViewFormatters,
): string[] {
	const lines: string[] = [];
	if (workflows.length === 0) {
		lines.push(line(warning("No workflows found.")));
		lines.push(line(muted("Create one with /workflow new <name> or dynamic_workflow action=write.")));
		return lines;
	}
	const start = windowStart(workflowIndex, workflows.length, 6, 12);
	const visible = workflows.slice(start, start + 12);
	for (let i = 0; i < visible.length; i++) {
		const index = start + i;
		const workflow = visible[i];
		const selected = index === workflowIndex;
		const prefix = selected ? accent("› ") : "  ";
		const scope = workflow.scope === "project" ? accent("project") : muted("global");
		lines.push(line(`${prefix}${workflow.name} ${muted("(")}${scope}${muted(")")} ${muted(workflow.relativePath)}`));
	}
	const selected = workflows[workflowIndex];
	if (selected) {
		lines.push(line(muted("")));
		lines.push(line(accent("Selected workflow")));
		lines.push(line(`name: ${selected.name}`));
		lines.push(line(`scope: ${selected.scope}`));
		lines.push(line(`path: ${selected.path}`));
		lines.push(line(muted("Enter/g opens graph • r runs with JSON + confirm • d/delete removes workflow file")));
	}
	return lines;
}

export function renderSessionsView(
	piSessions: PiSessionModel[],
	sessionIndex: number,
	{ line, accent, muted, success, warning }: DashboardStatusListViewFormatters,
): string[] {
	const lines: string[] = [];
	if (piSessions.length === 0) {
		lines.push(line(warning("No live Pi TUI/RPC sessions found.")));
		lines.push(line(muted("Persistent Pi sessions appear here after this extension starts and writes a heartbeat.")));
		return lines;
	}
	const live = piSessions.filter((session) => session.live).length;
	const stale = piSessions.length - live;
	lines.push(
		line(
			`${accent("Pi sessions")} ${muted(`(${piSessions.length})`)} ${live ? success(`live:${live}`) : muted("live:0")} ${stale ? warning(`stale:${stale}`) : muted("stale:0")} ${muted(`heartbeat:${formatElapsedMs(PI_SESSION_HEARTBEAT_MS)}`)}`,
		),
	);
	const start = windowStart(sessionIndex, piSessions.length, 6, 12);
	const visible = piSessions.slice(start, start + 12);
	for (let i = 0; i < visible.length; i++) {
		const index = start + i;
		const session = visible[i];
		const selected = index === sessionIndex;
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
	const selected = piSessions[sessionIndex];
	if (!selected) return lines;
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
	return lines;
}

export function renderRunsView(
	runs: WorkflowRunRecord[],
	runIndex: number,
	{ line, accent, muted, success, error, dim }: DashboardRunViewFormatters,
): string[] {
	const lines: string[] = [];
	if (runs.length === 0) {
		lines.push(line(muted("No se encontraron workflow runs.")));
		lines.push(line(muted(START_WORKFLOW_HINT)));
		return lines;
	}
	const start = windowStart(runIndex, runs.length, 6, 12);
	const visible = runs.slice(start, start + 12);
	lines.push(line(`${accent("Runs")} ${muted(`(${runs.length})`)}${muted(windowLabel(runs.length, start, 12))}`));
	for (let i = 0; i < visible.length; i++) {
		const index = start + i;
		const run = visible[i];
		const selected = index === runIndex;
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
	const selected = runs[runIndex];
	if (selected) {
		lines.push(line(muted("")));
		lines.push(line(accent("Selected run")));
		lines.push(line(`status: ${getRunStatusLabel(selected)}`));
		lines.push(line(`run: ${selected.runId}`));
		lines.push(line(`parallel: ${formatParallelAgents(selected)}`));
		lines.push(line(`dir: ${dim(selected.runDir)}`));
		if (selected.error)
			lines.push(line(`${accent("error")}: ${error(renderSafeInline(compactInline(selected.error, 200)))}`));
		for (const logEntry of getRunLogs(selected).slice(-5))
			lines.push(line(`${muted(logEntry.time.slice(11, 19))} ${renderSafeInline(logEntry.message)}`));
		// Action verbs live on the gated header banner; only the unique resume COMMAND
		// (not shown in the header) earns a footer line here.
		if (isResumableState(getRunState(selected))) lines.push(line(dim(`/workflow resume ${selected.runId}`)));
	}
	return lines;
}

export function renderActivityView(
	runs: WorkflowRunRecord[],
	activity: WorkflowActivityEntry[],
	activityIndex: number,
	{ line, accent, muted, success, error, warning }: DashboardActivityViewFormatters,
): string[] {
	const lines: string[] = [];
	const active = runs.filter((run) => canCancelRun(run));
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
	if (activity.length === 0) {
		lines.push(line(warning("No workflow activity yet.")));
		lines.push(line(muted(START_WORKFLOW_HINT)));
		return lines;
	}
	const start = windowStart(activityIndex, activity.length, 7, 14);
	const visible = activity.slice(start, start + 14);
	for (let i = 0; i < visible.length; i++) {
		const index = start + i;
		const entry = visible[i];
		const selected = index === activityIndex;
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
	const selected = activity[activityIndex];
	if (selected) {
		lines.push(line(muted("")));
		lines.push(line(accent("Selected activity")));
		lines.push(line(`workflow: ${selected.workflow}`));
		lines.push(line(`run: ${selected.runId}`));
		lines.push(line(`time: ${selected.time}`));
		// Action hints live on the gated header banner (render line 1); no redundant footer here.
	}
	return lines;
}
