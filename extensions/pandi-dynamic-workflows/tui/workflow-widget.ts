/**
 * Widget inferior de progreso en vivo — presentación TUI separada del lifecycle.
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
import { WORKFLOW_WIDGET_KEY } from "../lifecycle/status.js";
import { formatParallelAgentsCompact } from "../runtime/index.js";
import type { WorkflowLogEntry, WorkflowRunStatus } from "../types.js";

export function formatLiveRunView(
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

export function clearWorkflowWidget(ctx: ExtensionContext): void {
	if (ctx.hasUI) ctx.ui.setWidget(WORKFLOW_WIDGET_KEY, undefined);
}
