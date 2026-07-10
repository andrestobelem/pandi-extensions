/**
 * Fachada del grafo interactivo TUI — render, image y reexports del model en lib/graph.
 */

export {
	buildWorkflowGraphModel,
	buildWorkflowGraphModelWithSubworkflows,
	type ResolveWorkflowFn,
	type WorkflowGraphCall,
	type WorkflowGraphChildCall,
	type WorkflowGraphFanoutInfo,
	type WorkflowGraphFanoutUnit,
	type WorkflowGraphModel,
	type WorkflowGraphRenderTheme,
	type WorkflowGraphStep,
} from "../../lib/graph/index.js";
export type { WorkflowGraphImageAttempt, WorkflowGraphImageRender } from "./image.js";
export { renderWorkflowGraphImage, workflowGraphImageOptions } from "./image.js";
export {
	makeWorkflowGraphForContext,
	renderWorkflowGraphDocumentLines,
	renderWorkflowGraphMermaidLines,
	showWorkflowGraph,
} from "./render.js";
