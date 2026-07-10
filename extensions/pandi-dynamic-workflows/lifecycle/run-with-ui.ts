/**
 * Ejecución foreground con actualización de status/widget del host — capa lifecycle sobre runWorkflow.
 * tui reexporta para back-compat de dashboard/open y la fachada tui.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { runWorkflow } from "../runtime/index.js";
import type {
	PreparedWorkflowRun,
	RunLimits,
	WorkflowDefinition,
	WorkflowLogEntry,
	WorkflowRunResult,
	WorkflowRunStatus,
} from "../types.js";
import {
	clearWorkflowWidget,
	setWorkflowErrorStatus,
	setWorkflowFinishedStatus,
	setWorkflowRunningStatus,
	setWorkflowWidget,
} from "./status.js";

export async function runWorkflowWithUi(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	workflow: WorkflowDefinition,
	input: unknown,
	limits: RunLimits,
	signal: AbortSignal | undefined,
	onProgress?: (logs: WorkflowLogEntry[], status?: WorkflowRunStatus) => void,
	prepared?: PreparedWorkflowRun,
): Promise<WorkflowRunResult> {
	if (ctx.hasUI) {
		setWorkflowRunningStatus(ctx, workflow.name, []);
		setWorkflowWidget(ctx, workflow.name, []);
	}
	try {
		const result = await runWorkflow(
			pi,
			ctx,
			workflow,
			input,
			limits,
			signal,
			(logs, status) => {
				onProgress?.(logs, status);
				if (ctx.hasUI) {
					setWorkflowRunningStatus(ctx, workflow.name, logs, status);
					setWorkflowWidget(ctx, workflow.name, logs, status);
				}
			},
			prepared,
		);
		setWorkflowFinishedStatus(ctx, result);
		return result;
	} catch (err) {
		setWorkflowErrorStatus(ctx, workflow.name);
		throw err;
	} finally {
		clearWorkflowWidget(ctx);
	}
}
