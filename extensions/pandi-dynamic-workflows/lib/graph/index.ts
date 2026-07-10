/**
 * Fachada del workflow graph model (introspección estática + expansión opcional de sub-workflows).
 * El render interactivo vive en tui/graph/.
 */

export {
	buildWorkflowGraphModel,
	buildWorkflowGraphModelWithSubworkflows,
	type ResolveWorkflowFn,
} from "./model.js";
export {
	extractDirectStringLiteralArgument,
	extractFirstStringLiteral,
	findCallEndIndex,
	formatWorkflowGraphFanoutSummary,
	graphTextLabel,
	inferWorkflowGraphFanout,
	isJavaScriptCodePosition,
	lineNumberAtIndex,
	mermaidLabel,
	splitTopLevelArguments,
	summarizeWorkflowGraphChildren,
	workflowGraphMethodInfo,
} from "./parse.js";
export type {
	WorkflowGraphCall,
	WorkflowGraphChildCall,
	WorkflowGraphFanoutInfo,
	WorkflowGraphFanoutUnit,
	WorkflowGraphModel,
	WorkflowGraphRenderTheme,
	WorkflowGraphStep,
} from "./types.js";
