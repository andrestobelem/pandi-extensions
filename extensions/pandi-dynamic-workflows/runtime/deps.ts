/**
 * Contratos de resolución/preflight inyectados en el engine — surface los implementa;
 * runtime no importa surface.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ResolveWorkflowFn } from "../lib/graph/index.js";
import type { WorkflowDefinition } from "../types.js";

export type PreflightWorkflowLaunchFn = (
	ctx: ExtensionContext,
	workflow: WorkflowDefinition,
	input: unknown,
) => Promise<unknown>;

export type RuntimeWorkflowDeps = {
	resolveWorkflow: ResolveWorkflowFn;
	preflightWorkflowLaunch: PreflightWorkflowLaunchFn;
};
