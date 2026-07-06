/**
 * Flujos de trabajo dinámicos estilo Claude para Pi.
 *
 * Esta extensión añade:
 * - herramienta `dynamic_workflow` para que el modelo liste/lea/escriba/ejecute scripts de flujos de trabajo
 * - comandos `/workflow` y `/workflows` para usuarios
 * - comandos de enrutamiento `/dynamic-workflow` y `/deep-research`
 * - un pequeño motor de ejecución de flujos de trabajo JavaScript con subagentes Pi paralelos y artefactos
 *
 * Los flujos de trabajo son código de confianza. Se ejecutan dentro del proceso Pi (no en una
 * caja de arena de seguridad) y pueden consumir llamadas de modelo creando subagentes.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export { liveAgentHeaderStatus } from "./agent-view.js";
export { countRunArtifacts } from "./dashboard-collectors.js";
export { runProcess, runStreamingAgentProcess } from "./process-spawn.js";
export { settleWithinTimeout } from "./run-lifecycle.js";
export {
	activeRunCount,
	activeRunIds,
	clearActiveRuns,
	getActiveRun,
	hasActiveRun,
	listActiveRuns,
	registerActiveRun,
	unregisterActiveRun,
} from "./run-registry.js";

import { registerUltracodeInputEvents } from "./ultracode-input-events.js";
import { registerUltracodeModeEvent } from "./ultracode-mode-event.js";
import { createUltracodeRuntimeState } from "./ultracode-runtime-state.js";
import { registerUltracodeToggleCommands } from "./ultracode-toggle-commands.js";
import { registerWorkflowRoutingCommands } from "./workflow-routing-commands.js";
import { registerWorkflowSessionEvents } from "./workflow-session-events.js";
import { registerWorkflowShellCommands } from "./workflow-shell-commands.js";
import { registerDynamicWorkflowTool } from "./workflow-tool-registration.js";

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
} from "./event-parser.js";
export { appendFileMutexCount, appendJsonLine } from "./file-append.js";
export { estimatePeakParallelAgents } from "./run-state.js";
export { selectRunByKey } from "./run-view.js";
export {
	EXTENSION_ROOT,
	JOURNAL_FILE,
	MAX_AGENT_OUTPUT_IN_RESULT,
	MAX_JOURNALED_STREAM,
	PI_SESSION_HEARTBEAT_MS,
	PROCESS_KILL_GRACE_MS,
} from "./runtime-constants.js";
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
export { extractUltracodeTask } from "./ultracode.js";
export { currentWorkflowDepth, maxWorkflowDepth } from "./workflow-depth.js";
export { runWorkflow } from "./workflow-engine.js";
export { resolveWorkflowMenu } from "./workflow-menu.js";
export {
	formatWorkflowPreflightSummary,
	preflightWorkflowLaunch,
	type WorkflowPreflightResult,
} from "./workflow-preflight.js";
export {
	WORKFLOW_DIR,
	WORKFLOW_DRAFT_DIR,
	WORKFLOW_GRAPH_DIR,
	WORKFLOW_RUN_DIR,
} from "./workflow-resolve.js";
export { prepareWorkflowRun } from "./workflow-run-prepare.js";
export { transformWorkflowCode } from "./workflow-transform.js";

export default function dynamicWorkflowsExtension(pi: ExtensionAPI): void {
	const ultracodeState = createUltracodeRuntimeState();

	registerUltracodeModeEvent(pi, ultracodeState);

	registerDynamicWorkflowTool(pi);

	registerWorkflowShellCommands(pi);

	registerWorkflowRoutingCommands(pi, ultracodeState.getContractGateEnabled);
	registerUltracodeToggleCommands(pi, ultracodeState);
	registerUltracodeInputEvents(pi, ultracodeState);
	registerWorkflowSessionEvents(pi, ultracodeState);
}
