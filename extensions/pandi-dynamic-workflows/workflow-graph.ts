/**
 * Barrel de workflow-graph: reexporta model, render e image para back-compat de imports.
 * Tipos del modelo viven en workflow-graph-types.js (reexportados aquí).
 */

export type { WorkflowGraphImageAttempt, WorkflowGraphImageRender } from "./workflow-graph-image.js";
export { renderWorkflowGraphImage, workflowGraphImageOptions } from "./workflow-graph-image.js";
export { buildWorkflowGraphModelWithSubworkflows } from "./workflow-graph-model.js";
export {
	makeWorkflowGraphForContext,
	renderWorkflowGraphDocumentLines,
	renderWorkflowGraphMermaidLines,
	showWorkflowGraph,
} from "./workflow-graph-render.js";
export type {
	WorkflowGraphCall,
	WorkflowGraphChildCall,
	WorkflowGraphFanoutInfo,
	WorkflowGraphFanoutUnit,
	WorkflowGraphModel,
	WorkflowGraphRenderTheme,
	WorkflowGraphStep,
} from "./workflow-graph-types.js";
