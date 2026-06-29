/**
 * Run status presentation — the /workflow status line + bottom widget rendering, the run
 * summary/cancel predicates, and the showText helper. The host-facing status surface driven
 * by the engine and command handlers (showWorkflowGraph stays in index.ts with the graph
 * types it renders).
 *
 * Deferred cycle: refreshActiveWorkflowStatus reads activeRuns from ./index.js inside its
 * body and the engine calls the setWorkflow*Status helpers back; siblings import the run
 * summary/status helpers from here. Owns its two host status-key consts. Record types cross
 * as import type. Extracted byte-identically.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { MAX_TOOL_TEXT, stringify } from "./format.js";
import type { WorkflowLogEntry, WorkflowRunRecord, WorkflowRunResult, WorkflowRunStatus } from "./index.js";
import { activeRuns } from "./index.js";
import { notify } from "./notify.js";
import { shortWorkflowName, workflowDashboardHint, workflowProgress } from "./presentation.js";
import { renderSafeInline } from "./render-utils.js";
import { formatParallelAgents, formatParallelAgentsCompact, getRunState, getRunStatusLabel } from "./run-state.js";

const WORKFLOW_STATUS_KEY = "dynamic-workflows";
const WORKFLOW_WIDGET_KEY = "dynamic-workflows";

export function formatRunSummary(result: WorkflowRunResult): string {
	const status = getRunStatusLabel(result);
	const parts = [
		`Workflow ${status}: ${result.workflow}`,
		`Run: ${result.runId}`,
		`State: ${status}${result.background ? " (background)" : ""}`,
		`Agents: ${result.agentCount}`,
		`Parallel agents: ${formatParallelAgents(result)}`,
		`Elapsed: ${Math.round(result.elapsedMs / 1000)}s`,
		`Artifacts: ${result.runDir}`,
	];
	if (result.error) parts.push(`Error: ${result.error}`);
	if (result.output !== undefined) parts.push(`\nOutput:\n${stringify(result.output, MAX_TOOL_TEXT)}`);
	return parts.join("\n");
}

export async function showText(ctx: ExtensionContext, title: string, content: string): Promise<void> {
	if (ctx.mode === "print") {
		console.log(content);
		return;
	}
	if (ctx.hasUI) {
		await ctx.ui.editor(title, content);
		return;
	}
	notify(ctx, content, "info");
}

export function isActiveRunRecord(run: WorkflowRunRecord): boolean {
	return getRunState(run) === "running" && activeRuns.has(run.runId);
}

export function canCancelRun(run: WorkflowRunRecord): boolean {
	return isActiveRunRecord(run);
}

export function setWorkflowIdleStatus(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	ctx.ui.setStatus(WORKFLOW_STATUS_KEY, ctx.ui.theme.fg("dim", "wf · /workflows"));
}

export function setWorkflowRunningStatus(
	ctx: ExtensionContext,
	workflowName: string,
	logs: WorkflowLogEntry[],
	status?: WorkflowRunStatus,
): void {
	if (!ctx.hasUI) return;
	const theme = ctx.ui.theme;
	const { agentsStarted, agentsDone, agentsRunning, bashDone } = workflowProgress(logs);
	const progress = agentsStarted > 0 ? ` ${agentsDone}/${agentsStarted}` : "";
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

export function refreshActiveWorkflowStatus(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	const count = activeRuns.size;
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
	const { agentsStarted, agentsDone, agentsRunning, bashDone } = workflowProgress(logs);
	const latest = logs.slice(-1)[0];
	const line = (s: string) => truncateToWidth(s, w, "");
	const name = renderSafeInline(shortWorkflowName(workflowName));
	const parallel = status ? formatParallelAgentsCompact(status) : agentsRunning > 0 ? String(agentsRunning) : "0";
	return [
		line(
			`▶ wf ${name}  agents ${agentsDone}/${agentsStarted}  parallel ${parallel}  bash ${bashDone}  logs ${logs.length}`,
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
