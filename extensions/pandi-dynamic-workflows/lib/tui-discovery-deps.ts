/**
 * Holder y contrato de discovery deps para tui — evita tui→lifecycle→surface en tiempo de carga.
 * `lifecycle/runtime-deps.ts` cablea las implementaciones surface al arranque.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { WorkflowDefinition, WorkflowRunRecord, WorkflowScopeInput } from "../types.js";
import type { WorkflowPattern } from "./pattern-catalog.js";

/** Resolver surface con soporte forWrite (draft/workflow); más amplio que ResolveWorkflowFn del grafo. */
export type SurfaceResolveWorkflowFn = (
	ctx: ExtensionContext,
	name: string,
	scope?: WorkflowScopeInput,
	forWrite?: false | "draft" | "workflow",
) => Promise<WorkflowDefinition>;

/** Discovery/resolución que tui necesita sin importar surface directamente. */
export type TuiWorkflowDiscoveryDeps = {
	listWorkflows: (ctx: ExtensionContext) => Promise<WorkflowDefinition[]>;
	resolveWorkflow: SurfaceResolveWorkflowFn;
	resolveWorkflowForRun: (ctx: ExtensionContext, run: WorkflowRunRecord) => Promise<WorkflowDefinition | undefined>;
	loadWorkflowPatternCode: (pattern: WorkflowPattern) => Promise<string>;
};

let tuiWorkflowDiscoveryDeps: TuiWorkflowDiscoveryDeps | undefined;

export function setTuiWorkflowDiscoveryDeps(deps: TuiWorkflowDiscoveryDeps): void {
	tuiWorkflowDiscoveryDeps = deps;
}

export function requireTuiWorkflowDiscoveryDeps(): TuiWorkflowDiscoveryDeps {
	if (!tuiWorkflowDiscoveryDeps) {
		throw new Error(
			"TUI workflow discovery deps are not wired. Ensure lifecycle/runtime-deps is loaded before opening the dashboard.",
		);
	}
	return tuiWorkflowDiscoveryDeps;
}
