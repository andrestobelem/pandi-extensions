/**
 * Contratos de resolución/preflight inyectados en el engine — surface los implementa;
 * runtime no importa surface.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ResolveWorkflowFn } from "../lib/graph/index.js";
import type { WorkflowPattern } from "../lib/pattern-catalog.js";
import type { WorkflowDefinition, WorkflowRunRecord, WorkflowScopeInput } from "../types.js";

export type PreflightWorkflowLaunchFn = (
	ctx: ExtensionContext,
	workflow: WorkflowDefinition,
	input: unknown,
) => Promise<unknown>;

/** Resolver surface con soporte forWrite (draft/workflow); más amplio que ResolveWorkflowFn del grafo. */
export type SurfaceResolveWorkflowFn = (
	ctx: ExtensionContext,
	name: string,
	scope?: WorkflowScopeInput,
	forWrite?: false | "draft" | "workflow",
) => Promise<WorkflowDefinition>;

export type RuntimeWorkflowDeps = {
	resolveWorkflow: ResolveWorkflowFn;
	preflightWorkflowLaunch: PreflightWorkflowLaunchFn;
};

/** Discovery/resolución que tui necesita sin importar surface directamente. */
export type TuiWorkflowDiscoveryDeps = {
	listWorkflows: (ctx: ExtensionContext) => Promise<WorkflowDefinition[]>;
	resolveWorkflow: SurfaceResolveWorkflowFn;
	resolveWorkflowForRun: (ctx: ExtensionContext, run: WorkflowRunRecord) => Promise<WorkflowDefinition | undefined>;
	loadWorkflowPatternCode: (pattern: WorkflowPattern) => Promise<string>;
};
