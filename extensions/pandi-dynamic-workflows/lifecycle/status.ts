/**
 * Status de run activo en la barra del host — idle, progreso, fin/error y widget inferior.
 * Vive en lifecycle para que resume/start no dependan de tui; tui reexporta para dashboard/commands.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import {
	shortWorkflowName,
	workflowDashboardHint,
	workflowProgress,
	workflowProgressLabel,
} from "../lib/presentation.js";
import { renderSafeInline } from "../lib/text-sanitize.js";
import { formatParallelAgentsCompact } from "../runtime/index.js";
import type { WorkflowLogEntry, WorkflowRunResult, WorkflowRunStatus } from "../types.js";
import { activeRunCount } from "./registry.js";

/** Clave compartida con el host para la línea de status del workflow. */
export const WORKFLOW_STATUS_KEY = "dynamic-workflows";

/** Clave compartida con el host para el widget inferior de progreso en vivo. */
export const WORKFLOW_WIDGET_KEY = "dynamic-workflows";

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
	if (ctx.hasUI) ctx.ui.setWidget(WORKFLOW_WIDGET_KEY, undefined);
}

function formatLiveRunView(
	logs: WorkflowLogEntry[],
	workflowName: string,
	width = 80,
	status?: WorkflowRunStatus,
): string[] {
	if (width <= 0) return [];
	const w = width;
	const counts = workflowProgress(logs);
	const { agentsStarted, agentsDone, agentsRunning, bashDone } = counts;
	const latest = logs.slice(-1)[0];
	const line = (s: string) => truncateToWidth(s, w, "");
	const name = renderSafeInline(shortWorkflowName(workflowName));
	const parallel = status ? formatParallelAgentsCompact(status) : agentsRunning > 0 ? String(agentsRunning) : "0";
	const batchText = counts.batch ? `  ${renderSafeInline(workflowProgressLabel(counts))}` : "";
	return [
		line(
			`▶ wf ${name}${batchText}  agents ${agentsDone}/${agentsStarted}  parallel ${parallel}  bash ${bashDone}  logs ${logs.length}`,
		),
		line(
			latest
				? `${latest.time.slice(11, 19)} ${renderSafeInline(latest.message)}  •  ${workflowDashboardHint()}`
				: `Open monitor: ${workflowDashboardHint()}`,
		),
	];
}

export function setWorkflowWidget(
	ctx: ExtensionContext,
	workflowName: string,
	logs: WorkflowLogEntry[],
	status?: WorkflowRunStatus,
): void {
	if (!ctx.hasUI) return;
	if (ctx.mode !== "tui") {
		ctx.ui.setWidget(WORKFLOW_WIDGET_KEY, formatLiveRunView(logs, workflowName, undefined, status), {
			placement: "belowEditor",
		});
		return;
	}
	ctx.ui.setWidget(
		WORKFLOW_WIDGET_KEY,
		() => ({
			invalidate(): void {},
			render(width: number): string[] {
				return formatLiveRunView(logs, workflowName, width, status);
			},
		}),
		{ placement: "belowEditor" },
	);
}
