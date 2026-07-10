export { appendFileMutexCount, appendJsonLine } from "./lib/index.js";
export {
	activeRunCount,
	activeRunIds,
	clearActiveRuns,
	getActiveRun,
	hasActiveRun,
	listActiveRuns,
	registerActiveRun,
	settleWithinTimeout,
	unregisterActiveRun,
} from "./lifecycle/index.js";
export { runtimeWorkflowDeps } from "./lifecycle/runtime-deps.js";
export {
	booleanValue,
	formatAgentPhase,
	getAgentElapsedMs,
	isAgentMonitorState,
	mergeAgentMonitor,
	numberValue,
	phaseEventFields,
	readRunEvents,
	recordValue,
	stringArrayValue,
	stringValue,
} from "./observe/index.js";
export type { PreflightWorkflowLaunchFn, RuntimeWorkflowDeps } from "./runtime/deps.js";
export {
	currentWorkflowDepth,
	EXTENSION_ROOT,
	estimatePeakParallelAgents,
	JOURNAL_FILE,
	MAX_AGENT_OUTPUT_IN_RESULT,
	MAX_JOURNALED_STREAM,
	maxWorkflowDepth,
	PI_SESSION_HEARTBEAT_MS,
	PROCESS_KILL_GRACE_MS,
	prepareWorkflowRun,
	runProcess,
	runStreamingAgentProcess,
	selectRunByKey,
} from "./runtime/index.js";
export {
	formatWorkflowPreflightSummary,
	preflightWorkflowLaunch,
	resolveWorkflowMenu,
	transformWorkflowCode,
	WORKFLOW_DIR,
	WORKFLOW_DRAFT_DIR,
	WORKFLOW_GRAPH_DIR,
	WORKFLOW_RUN_DIR,
	type WorkflowPreflightResult,
} from "./surface/index.js";
export { countRunArtifacts, liveAgentHeaderStatus } from "./tui/index.js";
export type {
	ActiveWorkflowRun,
	AgentMonitorModel,
	AgentMonitorState,
	AgentOptions,
	AgentPhaseInfo,
	AskResult,
	BashResult,
	DynamicWorkflowAction,
	DynamicWorkflowToolParams,
	JournalCache,
	JournalRecord,
	PreparedWorkflowRun,
	RunLimits,
	SubagentResult,
	WorkflowDefinition,
	WorkflowFile,
	WorkflowLocation,
	WorkflowLogEntry,
	WorkflowResultIntegrity,
	WorkflowRunRecord,
	WorkflowRunResult,
	WorkflowRunState,
	WorkflowRunStatus,
	WorkflowScope,
	WorkflowScopeInput,
} from "./types.js";
export { extractUltracodeTask } from "./ultracode/index.js";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { runtimeWorkflowDeps } from "./lifecycle/runtime-deps.js";
import { runWorkflow as runWorkflowEngine } from "./runtime/index.js";
import type {
	PreparedWorkflowRun,
	RunLimits,
	WorkflowDefinition,
	WorkflowLogEntry,
	WorkflowRunResult,
	WorkflowRunStatus,
} from "./types.js";

/** API pública: cablea resolve/preflight de surface al engine sin exponer RuntimeWorkflowDeps. */
export async function runWorkflow(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	workflowDefinition: WorkflowDefinition,
	input: unknown,
	limits: RunLimits,
	signal: AbortSignal | undefined,
	onProgress?: (logs: WorkflowLogEntry[], status?: WorkflowRunStatus) => void,
	prepared?: PreparedWorkflowRun,
): Promise<WorkflowRunResult> {
	return runWorkflowEngine(
		pi,
		ctx,
		workflowDefinition,
		input,
		limits,
		signal,
		runtimeWorkflowDeps,
		onProgress,
		prepared,
	);
}
