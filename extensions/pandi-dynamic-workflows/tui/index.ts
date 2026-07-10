/**
 * Fachada del deep module `tui` — dashboard, agent view, run view y grafo interactivo.
 * Call sites externos importan desde aquí; el interior queda escondido.
 */

export type { AgentViewParts } from "./agent-view.js";
export {
	buildAgentViewParts,
	extractMarkdownSection,
	liveAgentHeaderStatus,
	resolveAgentArtifactPath,
	showLiveAgentView,
} from "./agent-view.js";
export type {
	WorkflowActivityEntry,
	WorkflowAgentEntry,
	WorkflowDashboardResult,
	WorkflowMonitorModel,
} from "./collectors.js";
export {
	canRerunRun,
	collectWorkflowActivity,
	collectWorkflowAgents,
	countRunArtifacts,
	deriveWorkflowMonitorModels,
} from "./collectors.js";
export { installWorkflowDashboardDownEditor } from "./down-editor.js";
export type {
	WorkflowGraphCall,
	WorkflowGraphChildCall,
	WorkflowGraphFanoutInfo,
	WorkflowGraphFanoutUnit,
	WorkflowGraphImageAttempt,
	WorkflowGraphImageRender,
	WorkflowGraphModel,
	WorkflowGraphRenderTheme,
	WorkflowGraphStep,
} from "./graph/index.js";
export {
	buildWorkflowGraphModelWithSubworkflows,
	makeWorkflowGraphForContext,
	renderWorkflowGraphDocumentLines,
	renderWorkflowGraphImage,
	renderWorkflowGraphMermaidLines,
	showWorkflowGraph,
	workflowGraphImageOptions,
} from "./graph/index.js";
export type {
	DashboardCommandSubmitter,
	DashboardOpener,
	WorkflowDashboardOpenOptions,
} from "./orchestration.js";
export {
	openWorkflowDashboard,
	parseWorkflowCommandArgument,
	switchToPiSession,
} from "./orchestration.js";
export {
	formatRunView,
	listRunFiles,
	openRunArtifact,
	pickAndOpenRunArtifact,
	showRunView,
} from "./run-view.js";
export { canCancelRun, formatRunSummary, isActiveRunRecord, showText } from "./status-ui.js";
