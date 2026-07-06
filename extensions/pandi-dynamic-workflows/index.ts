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
import { Key } from "@earendil-works/pi-tui";
import { notify } from "./notify.js";

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

import { handleTool, handleWorkflowCommand, handleWorkflowsCommand } from "./command-handlers.js";
import { openWorkflowDashboard } from "./dashboard-orchestration.js";
import {
	clearUltracodeContractGateStatus,
	clearUltracodeStatus,
	dynamicWorkflowToolAvailable,
	ensureDynamicWorkflowToolActive,
	extractUltracodeTask,
	isGeneratedUltracodePrompt,
	makeAlwaysOnUltracodeSystemPrompt,
	makeUltracodePrompt,
	parseToggleCommandValue,
	resolveUltracodeModeValue,
	sendWorkflowPrompt,
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

import { makeWorkflowPromptGuidelines, workflowToolSchema } from "./workflow-tool-contract.js";

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
/**
 * Standalone `/workflow` verbs (run without an extra argument) offered by the bare
 * `/workflow` selector. "list" is included so the previous bare default stays reachable;
 * verbs that need a `<name>`/`<run>` are left out of the menu (still typeable directly).
 */
const WORKFLOW_MENU_ITEMS = [
	"list — list saved workflows",
	"index — write the draft usage index (drafts/INDEX.md)",
	"patterns — browse the pattern scaffold catalog",
	"dashboard — open the interactive dashboard",
	"agents — open the dashboard on the agents view",
	"sessions — list background Pi sessions",
	"runs — list past workflow runs",
	"cleanup — remove stale runs",
];

/**
 * Resolve the `/workflow` argument, opening an interactive verb selector when the command
 * is invoked bare in a session with a UI (the "no args → menu" rule). Headless (no UI) and
 * explicit verbs keep the unchanged behavior; cancelling returns "", which handleWorkflowCommand
 * renders as its `list` default — so nothing regresses off-TUI.
 */
export async function resolveWorkflowMenu(args: string, ctx: ExtensionContext): Promise<string> {
	const trimmed = args.trim();
	if (trimmed || !ctx.hasUI || typeof ctx.ui.select !== "function") return trimmed;
	const choice = await ctx.ui.select("Dynamic workflows", WORKFLOW_MENU_ITEMS);
	return choice?.split(/\s+/)[0] ?? "";
}

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

	pi.registerTool({
		name: "dynamic_workflow",
		label: "Dynamic Workflow",
		description:
			"Create, manage, and run Claude-style dynamic workflows: JavaScript orchestration scripts that can spawn parallel Pi subagents and store artifacts outside chat context.",
		promptSnippet: "Create/list/read/write/run/start JavaScript workflows that orchestrate parallel Pi subagents.",
		promptGuidelines: makeWorkflowPromptGuidelines(),
		parameters: workflowToolSchema,
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			return await handleTool(pi, params, signal, onUpdate, ctx);
		},
	});

	pi.registerCommand("workflow", {
		description:
			"Manage dynamic workflows: /workflow list|index|dashboard|agents|sessions|patterns|graph|runs|view|new|edit|run|start|resume|cancel|cleanup|delete-run|delete",
		handler: async (args, ctx) => await handleWorkflowCommand(pi, await resolveWorkflowMenu(args, ctx), ctx),
	});

	pi.registerCommand("workflows", {
		description: "Open the dynamic workflows dashboard (or pass through to /workflow, e.g. /workflows agents)",
		handler: async (args, ctx) => await handleWorkflowsCommand(pi, args, ctx),
	});

	pi.registerShortcut(Key.ctrlAlt("w"), {
		description: "Open dynamic workflows dashboard",
		handler: async (ctx) => await openWorkflowDashboard(pi, ctx),
	});

	// /dynamic-workflow is the primary command; /ultracode is a working slash alias with identical
	// behavior. Both route the task through the ultracode Contract Gate + workflow guidance.
	const makeWorkflowRoutingHandler = (
		commandName: string,
		options: { promptMode?: "ultracode" | "deep-research"; usageTarget?: string } = {},
	) => {
		const promptMode = options.promptMode ?? "ultracode";
		const usageTarget = options.usageTarget ?? "<task>";
		return async (args: string, ctx: ExtensionContext) => {
			const task = args.trim();
			if (!task) {
				notify(ctx, `Usage: /${commandName} ${usageTarget}`, "warning");
				return;
			}
			if (!ensureDynamicWorkflowToolActive(pi))
				notify(
					ctx,
					`dynamic_workflow tool is not active; ${commandName} will only provide routing guidance.`,
					"warning",
				);
			sendWorkflowPrompt(pi, ctx, makeUltracodePrompt(task, promptMode, ultracodeContractGateEnabled));
		};
	};

	pi.registerCommand("dynamic-workflow", {
		description: "Ask Pi to solve a complex task using dynamic workflows when warranted",
		handler: makeWorkflowRoutingHandler("dynamic-workflow"),
	});

	pi.registerCommand("ultracode", {
		description: "Alias for /dynamic-workflow: solve a complex task using dynamic workflows when warranted",
		handler: makeWorkflowRoutingHandler("ultracode"),
	});

	pi.registerCommand("deep-research", {
		description: "Ask Pi to create/run a dynamic workflow for deep research",
		handler: makeWorkflowRoutingHandler("deep-research", {
			promptMode: "deep-research",
			usageTarget: "<research question>",
		}),
	});

	const makeToggleCommandHandler = (options: {
		resolveValue?: (args: string, ctx: ExtensionContext) => string | Promise<string>;
		getEnabled: () => boolean;
		setEnabled: (enabled: boolean) => void;
		syncStatus: (ctx: ExtensionContext) => void;
		onEnable?: (ctx: ExtensionContext) => void;
		statusMessage: (enabled: boolean) => string;
		enabledMessage: string;
		disabledMessage: string;
		usage: string;
	}) => {
		return async (args: string, ctx: ExtensionContext) => {
			const rawValue = options.resolveValue ? await options.resolveValue(args, ctx) : args;
			const value = parseToggleCommandValue(rawValue);
			if (value === "status") {
				options.syncStatus(ctx);
				notify(ctx, options.statusMessage(options.getEnabled()), "info");
				return;
			}
			if (value === "on") {
				options.setEnabled(true);
				options.onEnable?.(ctx);
				options.syncStatus(ctx);
				notify(ctx, options.enabledMessage, "info");
				return;
			}
			if (value === "off") {
				options.setEnabled(false);
				options.syncStatus(ctx);
				notify(ctx, options.disabledMessage, "warning");
				return;
			}
			notify(ctx, options.usage, "warning");
		};
	};

	pi.registerCommand("ultracode-contract", {
		description: "Show or toggle the Ultracode Contract Gate for this session",
		handler: makeToggleCommandHandler({
			getEnabled: () => ultracodeContractGateEnabled,
			setEnabled: (enabled) => {
				ultracodeContractGateEnabled = enabled;
			},
			syncStatus: (ctx) => setUltracodeContractGateStatus(ctx, ultracodeContractGateEnabled),
			statusMessage: (enabled) => `Ultracode Contract Gate is ${enabled ? "enabled" : "disabled"}.`,
			enabledMessage:
				"Ultracode Contract Gate enabled: substantive workflow tasks will include task-contract review guidance.",
			disabledMessage: "Ultracode Contract Gate disabled for this session; workflow routing remains available.",
			usage: "Usage: /ultracode-contract [on|off|status]",
		}),
	});

	pi.registerCommand("ultracode-mode", {
		description: "Show or toggle always-on ultracode workflow routing for this session",
		handler: makeToggleCommandHandler({
			resolveValue: resolveUltracodeModeValue,
			getEnabled: () => ultracodeAlwaysOn,
			setEnabled: (enabled) => {
				ultracodeAlwaysOn = enabled;
			},
			syncStatus: (ctx) => setUltracodeStatus(ctx, ultracodeAlwaysOn),
			onEnable: () => {
				ensureDynamicWorkflowToolActive(pi);
			},
			statusMessage: (enabled) => `Ultracode always-on is ${enabled ? "enabled" : "disabled"}.`,
			enabledMessage: "Ultracode always-on enabled: Pi will evaluate each task for workflow routing.",
			disabledMessage: "Ultracode always-on disabled for this session.",
			usage: "Usage: /ultracode-mode [on|off|status]",
		}),
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
