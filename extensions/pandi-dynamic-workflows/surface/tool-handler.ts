import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentToolUpdateCallback, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildLimits, limitParamsFromInput, normalizeWorkflowInput } from "../config.js";
import { text } from "../format.js";
import {
	cancelWorkflowRun,
	formatBackgroundStart,
	shouldLaunchWorkflowInBackground,
	startWorkflowBackground,
} from "../lifecycle/index.js";
import { writeRunReport } from "../observe/index.js";
import { formatWorkflowList } from "../presentation.js";
import { makeWorkflowGraphForContext } from "../tui/graph/index.js";
import {
	formatRunList,
	formatRunSummary,
	formatRunView,
	listRuns,
	resolveRun,
	runWorkflowWithUi,
} from "../tui/index.js";
import type { DynamicWorkflowToolParams, WorkflowLogEntry } from "../types.js";
import { currentWorkflowDepth, maxWorkflowDepth } from "../workflow-depth.js";
import { resumeWorkflowForCaller } from "../workflow-resume-usecase.js";
import {
	formatWorkflowPatternCatalog,
	getDefaultScaffold,
	loadWorkflowPatternCode,
	resolveWorkflowPattern,
	WORKFLOW_PATTERN_CATALOG,
} from "./pattern-scaffolds.js";
import { formatWorkflowPreflightSummary, preflightWorkflowLaunch } from "./preflight.js";
import { ensureDir, listWorkflows, resolveWorkflow } from "./resolve.js";
import { classifyDynamicWorkflowRequest } from "./tool-request.js";
import { transformWorkflowCode } from "./transform.js";

// Centraliza el preview de las últimas N líneas de log, formateadas como HH:MM:SS + mensaje.
function formatLogPreview(logs: WorkflowLogEntry[], max = 8): string {
	return logs
		.slice(-max)
		.map((entry) => `${entry.time.slice(11, 19)} ${entry.message}`)
		.join("\n");
}

export async function handleTool(
	pi: ExtensionAPI,
	params: DynamicWorkflowToolParams,
	signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback | undefined,
	ctx: ExtensionContext,
) {
	const request = classifyDynamicWorkflowRequest(params);
	const action = request.action;

	// Guardia de recursión: un subagente de flujo de trabajo (profundidad >= límite) no puede lanzar más flujos de trabajo.
	if (
		(action === "start" || action === "run" || action === "resume") &&
		currentWorkflowDepth() >= maxWorkflowDepth()
	) {
		throw new Error(
			`dynamic_workflow recursion guard: this session is at workflow depth ${currentWorkflowDepth()} ` +
				`(limit ${maxWorkflowDepth()}). A subagent spawned by a workflow must not start/run/resume more ` +
				`workflows — have the orchestrator run them, or raise PI_DYNAMIC_WORKFLOWS_MAX_DEPTH to override.`,
		);
	}

	if (request.kind === "pattern-scaffold") {
		const pattern = request.patternKey ? resolveWorkflowPattern(request.patternKey) : undefined;
		if (request.patternKey && !pattern) {
			throw new Error(
				`Unknown workflow pattern: ${request.patternKey}. Available: ${WORKFLOW_PATTERN_CATALOG.map((item) => item.key).join(", ")}`,
			);
		}
		if (pattern) {
			const scaffold = await loadWorkflowPatternCode(pattern);
			return { content: [text(scaffold)], details: { action, pattern, scaffold } };
		}
		return {
			content: [text(formatWorkflowPatternCatalog())],
			details: { action, patterns: WORKFLOW_PATTERN_CATALOG, scaffold: getDefaultScaffold() },
		};
	}

	if (request.kind === "collection" && action === "list") {
		const workflows = await listWorkflows(ctx);
		return { content: [text(formatWorkflowList(workflows))], details: { action, workflows } };
	}

	if (request.kind === "collection" && action === "runs") {
		const runs = await listRuns(ctx);
		return { content: [text(formatRunList(runs))], details: { action, runs } };
	}

	if (request.kind === "run" && action === "view") {
		const run = await resolveRun(ctx, request.runId);
		const view = await formatRunView(run);
		return { content: [text(view)], details: { action, run } };
	}

	if (request.kind === "run" && action === "report") {
		const run = await resolveRun(ctx, request.runId);
		const result = await writeRunReport(run, { watch: params.watch, signal });
		return {
			content: [
				text(
					`Run report ${params.watch ? "watched" : "written"}: ${result.reportPath}\nState: ${result.state}; writes: ${result.iterations}. Open it in a browser; artifact links resolve relative to the run dir.`,
				),
			],
			details: { action, runId: run.runId, ...result },
		};
	}

	if (request.kind === "run" && action === "cancel") {
		const message = await cancelWorkflowRun(ctx, request.runId);
		return { content: [text(message)], details: { action, message } };
	}

	if (request.kind === "run" && action === "resume") {
		// limitParamsFromInput extrae solo los parámetros de límite numérico pasados explícitamente
		// (concurrency/maxAgents/timeoutMs/agentTimeoutMs) de params, así que
		// reanudar los honra como start en lugar de ignorarlos silenciosamente.
		const presentation = await resumeWorkflowForCaller(
			pi,
			ctx,
			request.runId,
			{ force: !!params.force, limits: limitParamsFromInput(params) },
			signal,
			(logs) => {
				const preview = formatLogPreview(logs);
				onUpdate?.({ content: [text(preview)], details: { action, logCount: logs.length } });
			},
		);
		if (presentation.kind === "background") {
			return { content: [text(presentation.message)], details: { action, status: presentation.status } };
		}
		if (!presentation.ok) throw new Error(presentation.message);
		return { content: [text(presentation.message)], details: { action, result: presentation.result } };
	}

	if (request.kind === "workflow-definition" && action === "read") {
		const workflow = await resolveWorkflow(ctx, request.workflowName, request.scope);
		const code = await fs.readFile(workflow.path, "utf8");
		return { content: [text(code)], details: { action, workflow, code } };
	}

	if (request.kind === "workflow-definition" && action === "graph") {
		const workflow = await resolveWorkflow(ctx, request.workflowName, request.scope);
		const code = await fs.readFile(workflow.path, "utf8");
		const graph = await makeWorkflowGraphForContext(ctx, workflow, code);
		return { content: [text(graph)], details: { action, workflow, graph } };
	}

	if (request.kind === "workflow-definition" && action === "check") {
		const workflow = await resolveWorkflow(ctx, request.workflowName, request.scope);
		const workflowInput = normalizeWorkflowInput(params.input);
		const preflight = await preflightWorkflowLaunch(ctx, workflow, workflowInput);
		return { content: [text(formatWorkflowPreflightSummary(preflight))], details: { action, workflow, preflight } };
	}

	if (request.kind === "workflow-definition" && action === "write") {
		if (params.code === undefined) throw new Error("dynamic_workflow action=write requires code.");
		// Valida el contrato de autoría Y la sintaxis ANTES de persistir, para que el código
		// inválido falle aquí con el error instructivo de la transformación en lugar de
		// pasar a través de write y solo fallar mucho después en run/start (hallazgo de revisión
		// de Farley 2026-07-03 #8). new Function() analiza el
		// cuerpo compilado de CJS sin ejecutarlo.
		const compiled = transformWorkflowCode(params.code);
		try {
			new Function(compiled);
		} catch (err) {
			throw new Error(
				`Workflow code has a syntax error (fix it before writing): ${err instanceof Error ? err.message : String(err)}`,
			);
		}
		const workflow = await resolveWorkflow(ctx, request.workflowName, request.scope, "draft");
		await ensureDir(path.dirname(workflow.path));
		await fs.writeFile(workflow.path, params.code, "utf8");
		return {
			content: [text(`Wrote workflow ${workflow.name} (${workflow.scope}) to ${workflow.path}`)],
			details: { action, workflow },
		};
	}

	if (request.kind === "workflow-definition" && action === "delete") {
		const workflow = await resolveWorkflow(ctx, request.workflowName, request.scope);
		if (workflow.readOnly) throw new Error(`Cannot delete read-only workflow: ${workflow.name}`);
		if (!ctx.hasUI) throw new Error("Deleting workflows requires interactive confirmation.");
		const ok = await ctx.ui.confirm("Delete workflow?", `${workflow.name}\n${workflow.path}`);
		if (!ok) throw new Error("Workflow deletion cancelled.");
		await fs.unlink(workflow.path);
		return {
			content: [text(`Deleted workflow ${workflow.name} (${workflow.scope}) from ${workflow.path}`)],
			details: { action, workflow },
		};
	}

	if (
		request.kind === "workflow-definition" &&
		(action === "start" || (action === "run" && shouldLaunchWorkflowInBackground(ctx)))
	) {
		const workflow = await resolveWorkflow(ctx, request.workflowName, request.scope);
		const workflowInput = normalizeWorkflowInput(params.input);
		const limits = buildLimits({ ...limitParamsFromInput(workflowInput), ...params });
		const status = await startWorkflowBackground(pi, ctx, workflow, workflowInput, limits);
		return {
			content: [text(formatBackgroundStart(status))],
			details: { action, workflow, status },
		};
	}

	if (request.kind === "workflow-definition" && action === "run") {
		const workflow = await resolveWorkflow(ctx, request.workflowName, request.scope);
		const workflowInput = normalizeWorkflowInput(params.input);
		const limits = buildLimits({ ...limitParamsFromInput(workflowInput), ...params });
		const result = await runWorkflowWithUi(pi, ctx, workflow, workflowInput, limits, signal, (logs) => {
			const preview = formatLogPreview(logs);
			onUpdate?.({
				content: [text(preview)],
				details: { action, workflow, logCount: logs.length },
			});
		});
		if (!result.ok) throw new Error(formatRunSummary(result));
		return { content: [text(formatRunSummary(result))], details: { action, workflow, result } };
	}

	throw new Error(`Unknown dynamic_workflow action: ${String(action)}`);
}
