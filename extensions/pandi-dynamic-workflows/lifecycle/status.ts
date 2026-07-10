/**
 * Status de run activo en la barra del host — idle, progreso y fin/error.
 * El widget inferior delega en deps cableadas desde tui al arranque (sin importar tui acá).
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	shortWorkflowName,
	workflowDashboardHint,
	workflowProgress,
	workflowProgressLabel,
} from "../lib/presentation.js";
import { requireWorkflowWidgetDeps } from "../lib/workflow-widget-deps.js";

export { WORKFLOW_WIDGET_KEY } from "../lib/workflow-widget-key.js";

import { formatParallelAgentsCompact } from "../runtime/index.js";
import type { WorkflowLogEntry, WorkflowRunResult, WorkflowRunStatus } from "../types.js";
import { activeRunCount } from "./registry.js";

/** Clave compartida con el host para la línea de status del workflow. */
export const WORKFLOW_STATUS_KEY = "dynamic-workflows";

export function setWorkflowIdleStatus(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	ctx.ui.setStatus(WORKFLOW_STATUS_KEY, ctx.ui.theme.fg("dim", "wf · /workflows"));
}

export function refreshActiveWorkflowStatus(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	const count = activeRunCount();
	if (count === 0) {
		setWorkflowIdleStatus(ctx);
		return;
	}
	const theme = ctx.ui.theme;
	ctx.ui.setStatus(
		WORKFLOW_STATUS_KEY,
		`${theme.fg("accent", "▶ wf")} ${theme.fg("dim", `${count} bg ${workflowDashboardHint()}`)}`,
	);
}

export function setWorkflowRunningStatus(
	ctx: ExtensionContext,
	workflowName: string,
	logs: WorkflowLogEntry[],
	status?: WorkflowRunStatus,
): void {
	if (!ctx.hasUI) return;
	const theme = ctx.ui.theme;
	const counts = workflowProgress(logs);
	const { agentsRunning, bashDone } = counts;
	const progressText = workflowProgressLabel(counts);
	const progress = progressText ? ` ${progressText}` : "";
	const parallel = status ? formatParallelAgentsCompact(status) : agentsRunning > 0 ? String(agentsRunning) : "";
	const parallelText = parallel ? ` parallel:${parallel}` : "";
	const bash = bashDone > 0 ? ` bash:${bashDone}` : "";
	ctx.ui.setStatus(
		WORKFLOW_STATUS_KEY,
		`${theme.fg("accent", "▶ wf")} ${theme.fg("dim", shortWorkflowName(workflowName))}${theme.fg("accent", progress)}${theme.fg("dim", `${parallelText}${bash} ${workflowDashboardHint()}`)}`,
	);
}

export function setWorkflowFinishedStatus(ctx: ExtensionContext, result: WorkflowRunResult): void {
	if (!ctx.hasUI) return;
	const theme = ctx.ui.theme;
	const marker = result.ok ? theme.fg("success", "✓ wf") : theme.fg("error", "✗ wf");
	const elapsed = `${Math.round(result.elapsedMs / 1000)}s`;
	ctx.ui.setStatus(
		WORKFLOW_STATUS_KEY,
		`${marker} ${theme.fg("dim", `${shortWorkflowName(result.workflow)} ${elapsed} ${workflowDashboardHint()}`)}`,
	);
}

export function setWorkflowErrorStatus(ctx: ExtensionContext, workflowName: string): void {
	if (!ctx.hasUI) return;
	ctx.ui.setStatus(
		WORKFLOW_STATUS_KEY,
		`${ctx.ui.theme.fg("error", "✗ wf")} ${ctx.ui.theme.fg("dim", `${shortWorkflowName(workflowName)} ${workflowDashboardHint()}`)}`,
	);
}

export function clearWorkflowWidget(ctx: ExtensionContext): void {
	requireWorkflowWidgetDeps().clearWorkflowWidget(ctx);
}

export function setWorkflowWidget(
	ctx: ExtensionContext,
	workflowName: string,
	logs: WorkflowLogEntry[],
	status?: WorkflowRunStatus,
): void {
	requireWorkflowWidgetDeps().setWorkflowWidget(ctx, workflowName, logs, status);
}
