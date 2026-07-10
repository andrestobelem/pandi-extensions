/**
 * Fachada del grafo interactivo TUI — model, render, image y tipos públicos.
 * Sustituye el barrel plano workflow-graph.ts (sin shim en la raíz del paquete).
 */

export type { WorkflowGraphImageAttempt, WorkflowGraphImageRender } from "./image.js";
export { renderWorkflowGraphImage, workflowGraphImageOptions } from "./image.js";
export { buildWorkflowGraphModelWithSubworkflows } from "./model.js";
export {
	makeWorkflowGraphForContext,
	renderWorkflowGraphDocumentLines,
	renderWorkflowGraphMermaidLines,
	showWorkflowGraph,
} from "./render.js";
export type {
	WorkflowGraphCall,
	WorkflowGraphChildCall,
	WorkflowGraphFanoutInfo,
	WorkflowGraphFanoutUnit,
	WorkflowGraphModel,
	WorkflowGraphRenderTheme,
	WorkflowGraphStep,
} from "./types.js";
