import type { DynamicWorkflowToolParams, WorkflowScopeInput } from "../types.js";

type DynamicWorkflowAction = DynamicWorkflowToolParams["action"];

export type WorkflowDefinitionToolAction = Extract<
	DynamicWorkflowAction,
	"read" | "check" | "write" | "run" | "start" | "delete" | "graph"
>;

export type WorkflowRunToolAction = Extract<DynamicWorkflowAction, "view" | "report" | "cancel" | "resume">;

export type WorkflowCollectionToolAction = Extract<DynamicWorkflowAction, "list" | "runs">;

export interface WorkflowDefinitionToolRequest {
	kind: "workflow-definition";
	action: WorkflowDefinitionToolAction;
	workflowName: string;
	scope: WorkflowScopeInput;
	params: DynamicWorkflowToolParams;
}

export interface WorkflowRunToolRequest {
	kind: "run";
	action: WorkflowRunToolAction;
	runId?: string;
	params: DynamicWorkflowToolParams;
}

export interface WorkflowPatternScaffoldToolRequest {
	kind: "pattern-scaffold";
	action: "scaffold";
	patternKey?: string;
	params: DynamicWorkflowToolParams;
}

export interface WorkflowCollectionToolRequest {
	kind: "collection";
	action: WorkflowCollectionToolAction;
	params: DynamicWorkflowToolParams;
}

export type DynamicWorkflowRequest =
	| WorkflowDefinitionToolRequest
	| WorkflowRunToolRequest
	| WorkflowPatternScaffoldToolRequest
	| WorkflowCollectionToolRequest;

const WORKFLOW_DEFINITION_ACTIONS = new Set<DynamicWorkflowAction>([
	"read",
	"check",
	"write",
	"run",
	"start",
	"delete",
	"graph",
]);
const WORKFLOW_RUN_ACTIONS = new Set<DynamicWorkflowAction>(["view", "report", "cancel", "resume"]);
const WORKFLOW_COLLECTION_ACTIONS = new Set<DynamicWorkflowAction>(["list", "runs"]);

export function classifyDynamicWorkflowRequest(params: DynamicWorkflowToolParams): DynamicWorkflowRequest {
	const action = params.action;
	if (WORKFLOW_DEFINITION_ACTIONS.has(action)) {
		if (!params.name) throw new Error(`dynamic_workflow action=${action} requires name.`);
		return {
			kind: "workflow-definition",
			action: action as WorkflowDefinitionToolAction,
			workflowName: params.name,
			scope: params.scope ?? "auto",
			params,
		};
	}
	if (WORKFLOW_RUN_ACTIONS.has(action)) {
		return { kind: "run", action: action as WorkflowRunToolAction, runId: params.name, params };
	}
	if (action === "scaffold") {
		return { kind: "pattern-scaffold", action, patternKey: params.name, params };
	}
	if (WORKFLOW_COLLECTION_ACTIONS.has(action)) {
		return { kind: "collection", action: action as WorkflowCollectionToolAction, params };
	}
	throw new Error(`Unknown dynamic_workflow action: ${String(action)}`);
}
