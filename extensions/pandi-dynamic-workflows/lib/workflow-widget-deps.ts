/**
 * Holder de deps del widget inferior — lifecycle delega sin importar tui/pi-tui.
 * `workflow-extension-activation.ts` cablea la implementación TUI al arranque.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { WorkflowLogEntry, WorkflowRunStatus } from "../types.js";

export type WorkflowWidgetDeps = {
	setWorkflowWidget: (
		ctx: ExtensionContext,
		workflowName: string,
		logs: WorkflowLogEntry[],
		status?: WorkflowRunStatus,
	) => void;
	clearWorkflowWidget: (ctx: ExtensionContext) => void;
};

let workflowWidgetDeps: WorkflowWidgetDeps | undefined;

export function setWorkflowWidgetDeps(deps: WorkflowWidgetDeps): void {
	workflowWidgetDeps = deps;
}

export function requireWorkflowWidgetDeps(): WorkflowWidgetDeps {
	if (!workflowWidgetDeps) {
		throw new Error(
			"Workflow widget deps are not wired. Ensure workflow-extension-activation is loaded before updating the live run widget.",
		);
	}
	return workflowWidgetDeps;
}
