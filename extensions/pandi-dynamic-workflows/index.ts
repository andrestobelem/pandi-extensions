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

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export { runProcess, runStreamingAgentProcess } from "./process-spawn.js";

import { installWorkflowDashboardDownEditor } from "./dashboard-down-editor.js";
import { startPiSessionHeartbeat, stopPiSessionHeartbeat } from "./pi-session.js";
import {
	abortActiveWorkflowRuns,
	interruptActiveWorkflowRunsForReload,
	resumeReloadInterruptedWorkflowRuns,
} from "./run-lifecycle.js";

export { countRunArtifacts } from "./dashboard-collectors.js";
export { settleWithinTimeout } from "./run-lifecycle.js";

import {
	clearUltracodeContractGateStatus,
	clearUltracodeStatus,
	dynamicWorkflowToolAvailable,
	ensureDynamicWorkflowToolActive,
	extractUltracodeTask,
	isGeneratedUltracodePrompt,
	makeAlwaysOnUltracodeSystemPrompt,
	makeUltracodePrompt,
	setUltracodeContractGateStatus,
	setUltracodeStatus,
} from "./ultracode.js";

export { liveAgentHeaderStatus } from "./agent-view.js";
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

import { registerUltracodeToggleCommands } from "./ultracode-toggle-commands.js";
import { registerWorkflowRoutingCommands } from "./workflow-routing-commands.js";
import { registerWorkflowShellCommands } from "./workflow-shell-commands.js";
import { registerDynamicWorkflowTool } from "./workflow-tool-registration.js";

export { appendFileMutexCount, appendJsonLine } from "./file-append.js";
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

import { clearWorkflowWidget, refreshActiveWorkflowStatus, setWorkflowIdleStatus } from "./run-status-ui.js";

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

// Etiqueta incrustada en el borde superior del editor (línea de prompt violeta) mientras
// el enrutamiento Ultracode siempre activo está activo, para que el estado del enrutador también sea visible ahí.
const ULTRACODE_BORDER_LABEL = "ultracode auto";
// Gancho inter-extensión de mejor esfuerzo usado por extensions/effort/index.ts para `/effort ultracode`.
const ULTRACODE_MODE_EVENT = "pandi-dynamic-workflows:ultracode-mode";
export default function dynamicWorkflowsExtension(pi: ExtensionAPI): void {
	let ultracodeAlwaysOn = true;
	let ultracodeContractGateEnabled = true;
	let currentCtx: ExtensionContext | undefined;

	pi.events?.on?.(ULTRACODE_MODE_EVENT, (data) => {
		const request = data as { enabled?: unknown } | undefined;
		ultracodeAlwaysOn = request?.enabled !== false;
		if (ultracodeAlwaysOn) ensureDynamicWorkflowToolActive(pi);
		if (currentCtx) setUltracodeStatus(currentCtx, ultracodeAlwaysOn);
	});

	registerDynamicWorkflowTool(pi);

	registerWorkflowShellCommands(pi);

	registerWorkflowRoutingCommands(pi, () => ultracodeContractGateEnabled);
	registerUltracodeToggleCommands(pi, {
		getContractGateEnabled: () => ultracodeContractGateEnabled,
		setContractGateEnabled: (enabled) => {
			ultracodeContractGateEnabled = enabled;
		},
		getAlwaysOn: () => ultracodeAlwaysOn,
		setAlwaysOn: (enabled) => {
			ultracodeAlwaysOn = enabled;
		},
	});

	pi.on("input", (event) => {
		if (event.source === "extension") return;
		const task = extractUltracodeTask(event.text);
		if (!task) return;
		ensureDynamicWorkflowToolActive(pi);
		return {
			action: "transform" as const,
			text: makeUltracodePrompt(task, "ultracode", ultracodeContractGateEnabled),
			images: event.images,
		};
	});

	pi.on("before_agent_start", async (event) => {
		if (!ultracodeAlwaysOn) return;
		if (isGeneratedUltracodePrompt(event.prompt)) return;
		if (
			!dynamicWorkflowToolAvailable(event.systemPromptOptions.selectedTools) &&
			!ensureDynamicWorkflowToolActive(pi)
		)
			return;
		return {
			systemPrompt: `${event.systemPrompt}\n\n${makeAlwaysOnUltracodeSystemPrompt(ultracodeContractGateEnabled)}`,
		};
	});

	pi.on("session_start", async (event, ctx) => {
		currentCtx = ctx;
		await startPiSessionHeartbeat(event, ctx);
		installWorkflowDashboardDownEditor(pi, ctx, () => (ultracodeAlwaysOn ? ULTRACODE_BORDER_LABEL : undefined));
		if (ultracodeAlwaysOn) ensureDynamicWorkflowToolActive(pi);
		refreshActiveWorkflowStatus(ctx);
		setUltracodeStatus(ctx, ultracodeAlwaysOn);
		setUltracodeContractGateStatus(ctx, ultracodeContractGateEnabled);
		if (event.reason === "reload") await resumeReloadInterruptedWorkflowRuns(pi, ctx);
	});

	pi.on("session_shutdown", async (event, ctx) => {
		await stopPiSessionHeartbeat();
		if (event.reason === "reload") await interruptActiveWorkflowRunsForReload();
		else await abortActiveWorkflowRuns("Workflow cancelled by session shutdown.");
		clearWorkflowWidget(ctx);
		setWorkflowIdleStatus(ctx);
		clearUltracodeStatus(ctx);
		clearUltracodeContractGateStatus(ctx);
		currentCtx = undefined;
	});
}
