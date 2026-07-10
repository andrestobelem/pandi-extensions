/**
 * Presentación de status de run — predicados de resumen/cancel de run y el helper showText.
 * Los setters de progreso/fin/error y el widget inferior viven en lifecycle/status; se reexportan acá
 * para back-compat de la fachada tui (session-events, command-handlers, orchestration).
 *
 * showWorkflowGraph queda en index.ts con los tipos de graph que renderiza.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { notify } from "../lib/notify.js";
import { hasActiveRun } from "../lifecycle/index.js";
import {
	clearWorkflowWidget,
	refreshActiveWorkflowStatus,
	setWorkflowErrorStatus,
	setWorkflowFinishedStatus,
	setWorkflowIdleStatus,
	setWorkflowRunningStatus,
	setWorkflowWidget,
} from "../lifecycle/status.js";
import { getRunState } from "../runtime/index.js";
import type { WorkflowRunRecord } from "../types.js";

export { formatRunSummary } from "../lib/run-summary.js";
export {
	clearWorkflowWidget,
	refreshActiveWorkflowStatus,
	setWorkflowErrorStatus,
	setWorkflowFinishedStatus,
	setWorkflowIdleStatus,
	setWorkflowRunningStatus,
	setWorkflowWidget,
};

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
	return getRunState(run) === "running" && hasActiveRun(run.runId);
}

export function canCancelRun(run: WorkflowRunRecord): boolean {
	return isActiveRunRecord(run);
}
