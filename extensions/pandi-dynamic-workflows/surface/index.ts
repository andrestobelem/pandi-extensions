/**
 * Fachada del deep module `surface` — resolve, preflight, transform, tool y slash commands.
 * Call sites externos importan desde aquí; el interior queda escondido.
 */

export type { WorkflowPattern } from "./catalog.js";
export { getPatternUseCases, resolveWorkflowPattern, WORKFLOW_PATTERN_CATALOG } from "./catalog.js";
export type { WorkflowCommandParsed } from "./command-browse.js";
export { handleBrowseWorkflowCommand } from "./command-browse.js";
export {
	type CleanupArgs,
	DEFAULT_CLEANUP_KEEP,
	DEFAULT_CLEANUP_OLDER_THAN_MS,
	handleTool,
	handleWorkflowCommand,
	handleWorkflowsCommand,
	parseCleanupArgs,
	parseRunReportArgs,
	type RunReportCommandArgs,
} from "./command-handlers.js";
export { handleLifecycleWorkflowCommand } from "./command-lifecycle.js";
export { resolveWorkflowMenu } from "./menu.js";
export {
	formatWorkflowCompositionPromptGuidance,
	formatWorkflowCompositionPromptSummary,
	formatWorkflowPatternCatalog,
	formatWorkflowPatternKeyList,
	formatWorkflowPatternPromptCheatSheet,
	getDefaultScaffold,
	getWorkflowPatternPath,
	listOrphanedScaffoldKeys,
	loadWorkflowPatternCode,
} from "./pattern-scaffolds.js";
export {
	formatWorkflowPreflightSummary,
	preflightWorkflowLaunch,
	type WorkflowPreflightResult,
} from "./preflight.js";
export {
	createRunDirectory,
	ensureDir,
	getGraphRoot,
	getRunRoots,
	listWorkflows,
	parsePatternFlag,
	projectHash,
	resolveWorkflow,
	resolveWorkflowForRun,
	slugify,
	WORKFLOW_DIR,
	WORKFLOW_DRAFT_DIR,
	WORKFLOW_GRAPH_DIR,
	WORKFLOW_RUN_DIR,
} from "./resolve.js";
export { registerWorkflowRoutingCommands } from "./routing-commands.js";
export { registerWorkflowShellCommands } from "./shell-commands.js";
export { makeWorkflowPromptGuidelines, TOOL_ACTIONS, workflowToolSchema } from "./tool-contract.js";
export { registerDynamicWorkflowTool } from "./tool-registration.js";
export {
	classifyDynamicWorkflowRequest,
	type DynamicWorkflowRequest,
	type WorkflowCollectionToolAction,
	type WorkflowCollectionToolRequest,
	type WorkflowDefinitionToolAction,
	type WorkflowDefinitionToolRequest,
	type WorkflowPatternScaffoldToolRequest,
	type WorkflowRunToolAction,
	type WorkflowRunToolRequest,
} from "./tool-request.js";
export { transformWorkflowCode } from "./transform.js";
