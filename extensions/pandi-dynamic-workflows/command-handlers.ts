/**
 * Command/tool handlers — the dispatch bodies behind the dynamic_workflow tool and the
 * /workflow + /workflows commands. The thin glue between the activate registrations and
 * the engine / lifecycle / orchestration / ultracode layers.
 *
 * Fully-deferred cycle: every collaborator is called inside a handler body, so index.ts
 * imports the three entry points back and the activate body wires them into
 * registerTool/registerCommand. Imports filled in from the gate (typecheck + biome).
 * Extracted byte-identically.
 */
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	type AgentToolUpdateCallback,
	CONFIG_DIR_NAME,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	cleanupWorkflowDrafts,
	cleanupWorkflowTmp,
	formatCleanupInventory,
	inventoryWorkflowRuns,
} from "./cleanup-inventory.js";
import { buildLimits, limitParamsFromInput, normalizeWorkflowInput, parseCliJsonOrText } from "./config.js";
import {
	openWorkflowDashboard,
	parseWorkflowCommandArgument,
	runWorkflowWithUi,
	switchToPiSession,
} from "./dashboard-orchestration.js";
import { text } from "./format.js";
import { notify } from "./notify.js";
import {
	formatWorkflowPatternCatalog,
	getDefaultScaffold,
	loadWorkflowPatternCode,
	resolveWorkflowPattern,
	WORKFLOW_PATTERN_CATALOG,
} from "./pattern-scaffolds.js";
import { collectPiSessions, formatPiSessionList, prunePiSessionFiles } from "./pi-session.js";
import { formatDraftUsageIndex, formatWorkflowList } from "./presentation.js";
import {
	cancelWorkflowRun,
	cleanupWorkflowRuns,
	DEFAULT_CLEANUP_KEEP,
	deleteWorkflowRun,
	formatBackgroundStart,
	resumeWorkflow,
	shouldLaunchWorkflowInBackground,
	startWorkflowBackground,
} from "./run-lifecycle.js";
import { writeRunReport } from "./run-report-writer.js";
import { getRunState, getRunStatusLabel } from "./run-state.js";
import { canCancelRun, clearWorkflowWidget, formatRunSummary, showText } from "./run-status-ui.js";
import { formatRunList, formatRunView, listRuns, resolveRun, showRunView } from "./run-view.js";
import type { DynamicWorkflowToolParams, WorkflowLogEntry, WorkflowRunResult, WorkflowRunStatus } from "./types.js";
import { currentWorkflowDepth, maxWorkflowDepth } from "./workflow-depth.js";
import { makeWorkflowGraphForContext, showWorkflowGraph } from "./workflow-graph.js";
import { formatWorkflowPreflightSummary, preflightWorkflowLaunch } from "./workflow-preflight.js";
import { ensureDir, listWorkflows, parsePatternFlag, resolveWorkflow, WORKFLOW_DRAFT_DIR } from "./workflow-resolve.js";
import { classifyDynamicWorkflowRequest } from "./workflow-tool-request.js";
import { transformWorkflowCode } from "./workflow-transform.js";

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
		const resumeInBackground = shouldLaunchWorkflowInBackground(ctx);
		const record = await resumeWorkflow(
			pi,
			ctx,
			request.runId,
			// limitParamsFromInput extrae solo los parámetros de límite numérico pasados explícitamente
			// (concurrency/maxAgents/timeoutMs/agentTimeoutMs) de params, así que
			// reanudar los honra como start en lugar de ignorarlos silenciosamente.
			{ background: resumeInBackground, force: !!params.force, limits: limitParamsFromInput(params) },
			signal,
			(logs) => {
				const preview = formatLogPreview(logs);
				onUpdate?.({ content: [text(preview)], details: { action, logCount: logs.length } });
			},
		);
		if (resumeInBackground) {
			const status = record as WorkflowRunStatus;
			return { content: [text(formatBackgroundStart(status))], details: { action, status } };
		}
		const result = record as WorkflowRunResult;
		if (!result.ok) throw new Error(formatRunSummary(result));
		return { content: [text(formatRunSummary(result))], details: { action, result } };
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
		if (workflow.readOnly) throw new Error(`Cannot delete read-only bundled workflow: ${workflow.name}`);
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

// Re-exported from run-lifecycle.ts (single source of truth for the retention default) so
// the CLI parser and its test can reference it without reaching across modules.
export { DEFAULT_CLEANUP_KEEP };

export const DEFAULT_CLEANUP_OLDER_THAN_MS = 24 * 60 * 60 * 1000;

export interface CleanupArgs {
	target: "sessions" | "runs" | "drafts" | "tmp" | "both" | "all";
	keep: number;
	olderThanMs: number;
	includeHeartbeatStale: boolean;
	dryRun: boolean;
	yes: boolean;
}

// Centraliza el preview de las últimas N líneas de log, formateadas como HH:MM:SS + mensaje.
function formatLogPreview(logs: WorkflowLogEntry[], max = 8): string {
	return logs
		.slice(-max)
		.map((entry) => `${entry.time.slice(11, 19)} ${entry.message}`)
		.join("\n");
}

function parseCleanupDurationMs(raw: string): number | undefined {
	const match = /^(\d+)([mhd])$/.exec(raw.trim());
	if (!match) return undefined;
	const value = Number.parseInt(match[1] ?? "", 10);
	if (!Number.isFinite(value)) return undefined;
	const unit = match[2];
	if (unit === "m") return value * 60 * 1000;
	if (unit === "h") return value * 60 * 60 * 1000;
	return value * 24 * 60 * 60 * 1000;
}

// Pure parser for `/workflow cleanup [sessions|runs|drafts|tmp|both|all] [--keep=N] [--older-than=24h] [--all-stale] [--dry-run|-n] [--yes|-y]`.
// Order-independent; unknown tokens are ignored (target stays "both"). Safe defaults: sessions+runs,
// keep the DEFAULT_CLEANUP_KEEP most-recent runs, leave heartbeat-stale sessions, use a 24h age
// threshold for drafts/tmp, and neither preview nor auto-confirm.
export function parseCleanupArgs(afterAction: string): CleanupArgs {
	const result: CleanupArgs = {
		target: "both",
		keep: DEFAULT_CLEANUP_KEEP,
		olderThanMs: DEFAULT_CLEANUP_OLDER_THAN_MS,
		includeHeartbeatStale: false,
		dryRun: false,
		yes: false,
	};
	for (const token of afterAction.trim().split(/\s+/).filter(Boolean)) {
		if (token === "sessions" || token === "session") result.target = "sessions";
		else if (token === "runs" || token === "run") result.target = "runs";
		else if (token === "drafts" || token === "draft") result.target = "drafts";
		else if (token === "tmp" || token === "temp") result.target = "tmp";
		else if (token === "both") result.target = "both";
		else if (token === "all") result.target = "all";
		else if (token === "--all-stale") result.includeHeartbeatStale = true;
		else if (token === "--dry-run" || token === "-n") result.dryRun = true;
		else if (token === "--yes" || token === "-y") result.yes = true;
		else if (token.startsWith("--keep=")) {
			const value = Number.parseInt(token.slice("--keep=".length), 10);
			if (Number.isFinite(value)) result.keep = Math.max(0, value);
		} else if (token.startsWith("--older-than=")) {
			const value = parseCleanupDurationMs(token.slice("--older-than=".length));
			if (value !== undefined) result.olderThanMs = value;
		}
	}
	return result;
}

export interface RunReportCommandArgs {
	runId?: string;
	outPath?: string;
	watch: boolean;
	missingOutPath: boolean;
}

export function parseRunReportArgs(afterAction: string): RunReportCommandArgs {
	const tokens = afterAction.split(/\s+/).filter(Boolean);
	const result: RunReportCommandArgs = { watch: false, missingOutPath: false };
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		if (token === "--watch") {
			result.watch = true;
			continue;
		}
		if (token === "-o" || token === "--out") {
			const next = tokens[i + 1];
			if (!next || next.startsWith("-")) {
				result.missingOutPath = true;
				continue;
			}
			result.outPath = next;
			i++;
			continue;
		}
		if (!token.startsWith("-") && result.runId === undefined) result.runId = token;
	}
	if (result.runId === "latest") result.runId = undefined;
	return result;
}

export async function handleWorkflowCommand(pi: ExtensionAPI, args: string, ctx: ExtensionContext): Promise<void> {
	const trimmed = args.trim();
	const actionMatch = /^(\S+)(?:\s+([\s\S]*))?$/.exec(trimmed);
	const action = (actionMatch?.[1] || "list").toLowerCase();
	const afterAction = actionMatch?.[2]?.trimStart() ?? "";
	const nameMatch = /^(\S+)(?:\s+([\s\S]*))?$/.exec(afterAction);
	const commandName = nameMatch?.[1];
	const trailingText = nameMatch?.[2] ?? "";

	try {
		if (action === "list" || action === "ls") {
			notify(ctx, formatWorkflowList(await listWorkflows(ctx)), "info");
			return;
		}

		if (action === "index") {
			const draftsRoot = path.join(ctx.cwd, CONFIG_DIR_NAME, WORKFLOW_DRAFT_DIR);
			// Solo borradores del proyecto: el índice vive en el directorio de borradores del proyecto y el
			// almacén tiene alcance de proyecto. Los borradores se reconocen por ubicación (sus nombres son
			// cortos; el prefijo drafts/ es solo la forma de invocación).
			const draftNames = (await listWorkflows(ctx))
				.filter((file) => file.path.startsWith(draftsRoot + path.sep))
				.map((file) => file.name);
			const markdown = formatDraftUsageIndex(
				draftNames,
				(await listRuns(ctx)).map((run) => ({
					workflow: run.workflow,
					state: getRunState(run),
					startedAt: run.startedAt,
				})),
			);
			await ensureDir(draftsRoot);
			const indexPath = path.join(draftsRoot, "INDEX.md");
			await fs.writeFile(indexPath, `${markdown}\n`, "utf8");
			notify(ctx, `Draft usage index written: ${indexPath}`, "info");
			return;
		}

		if (action === "dashboard" || action === "tui") {
			await openWorkflowDashboard(pi, ctx);
			return;
		}

		if (action === "agents" || action === "agent") {
			await openWorkflowDashboard(pi, ctx, "agents");
			return;
		}

		if (action === "sessions" || action === "session") {
			if (ctx.mode === "tui") await openWorkflowDashboard(pi, ctx, "sessions");
			else await showText(ctx, "Pi sessions", formatPiSessionList(await collectPiSessions(ctx)));
			return;
		}

		if (action === "switch-session") {
			const sessionFile = parseWorkflowCommandArgument(afterAction);
			if (!sessionFile) {
				notify(ctx, "Usage: /workflow switch-session <session-file>", "warning");
				return;
			}
			const resolvedSessionFile = path.isAbsolute(sessionFile) ? sessionFile : path.resolve(ctx.cwd, sessionFile);
			const sessions = await collectPiSessions(ctx);
			const session = sessions.find(
				(item) => item.sessionFile && path.resolve(item.sessionFile) === resolvedSessionFile,
			) ?? {
				id: `manual:${resolvedSessionFile}`,
				pid: 0,
				mode: "session",
				cwd: ctx.cwd,
				startedAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				file: resolvedSessionFile,
				live: false,
				current: false,
				ageMs: Number.POSITIVE_INFINITY,
				sessionFile: resolvedSessionFile,
				sessionName: path.basename(resolvedSessionFile),
				staleReason: "not in live registry",
			};
			await switchToPiSession(ctx, session);
			return;
		}

		if (action === "patterns" || action === "catalog" || action === "scaffolds") {
			if (ctx.mode === "tui") await openWorkflowDashboard(pi, ctx, "patterns");
			else await showText(ctx, "Workflow pattern catalog", formatWorkflowPatternCatalog());
			return;
		}

		if (action === "graph" || action === "viz") {
			const name = commandName;
			if (!name) {
				notify(ctx, "Usage: /workflow graph <name>", "warning");
				return;
			}
			const workflow = await resolveWorkflow(ctx, name, "auto");
			const code = await fs.readFile(workflow.path, "utf8");
			await showWorkflowGraph(ctx, workflow, code);
			return;
		}

		if (action === "check") {
			const name = commandName;
			if (!name) {
				notify(ctx, "Usage: /workflow check <name> [json-input]", "warning");
				return;
			}
			const workflow = await resolveWorkflow(ctx, name, "auto");
			const input = parseCliJsonOrText(trailingText.trim());
			const preflight = await preflightWorkflowLaunch(ctx, workflow, input);
			notify(ctx, formatWorkflowPreflightSummary(preflight), "info");
			return;
		}

		if (action === "runs") {
			await showText(ctx, "Workflow runs", formatRunList(await listRuns(ctx)));
			return;
		}

		if (action === "view") {
			const run = await resolveRun(ctx, commandName);
			await showRunView(ctx, run);
			return;
		}

		if (action === "report") {
			// /workflow report [runId|latest] [--watch] [-o out.html] — default output is
			// INSIDE the run dir so relative artifact links resolve; -o elsewhere breaks
			// those links, so it warns.
			const reportArgs = parseRunReportArgs(afterAction);
			if (reportArgs.missingOutPath) {
				notify(ctx, "Usage: /workflow report [runId|latest] [--watch] [-o out.html]", "warning");
				return;
			}
			const run = await resolveRun(ctx, reportArgs.runId);
			let announcedWatchPath = false;
			const result = await writeRunReport(run, {
				watch: reportArgs.watch,
				...(reportArgs.outPath ? { outPath: path.resolve(ctx.cwd, reportArgs.outPath) } : {}),
				...(reportArgs.watch
					? {
							onWrite: (snapshot) => {
								if (!announcedWatchPath && snapshot.refreshing) {
									announcedWatchPath = true;
									notify(ctx, `Watching run report: ${snapshot.reportPath}`, "info");
								}
							},
						}
					: {}),
			});
			const outsideRunDir =
				reportArgs.outPath !== undefined && !result.reportPath.startsWith(path.resolve(run.runDir) + path.sep);
			notify(
				ctx,
				`Run report ${reportArgs.watch ? "watched" : "written"}: ${result.reportPath}\nState: ${result.state}; writes: ${result.iterations}.${outsideRunDir ? "\nWarning: written outside the run dir — relative artifact links will not resolve." : ""}`,
				outsideRunDir ? "warning" : "info",
			);
			return;
		}

		if (action === "new" || action === "create") {
			const name = commandName;
			if (!name) {
				notify(ctx, "Usage: /workflow new <name> [--pattern=<key>]", "warning");
				return;
			}
			if (!ctx.hasUI) {
				notify(
					ctx,
					"/workflow new requires interactive UI. Use dynamic_workflow action=write in agent mode.",
					"warning",
				);
				return;
			}
			const patternKey = parsePatternFlag(trailingText);
			const pattern = patternKey ? resolveWorkflowPattern(patternKey) : undefined;
			if (patternKey && !pattern) {
				notify(
					ctx,
					`Unknown workflow pattern: ${patternKey}. Available: ${WORKFLOW_PATTERN_CATALOG.map((item) => item.key).join(", ")}`,
					"warning",
				);
				return;
			}
			const scaffold = pattern ? await loadWorkflowPatternCode(pattern) : getDefaultScaffold();
			const edited = await ctx.ui.editor(
				pattern ? `New workflow: ${name} (${pattern.key})` : `New workflow: ${name}`,
				scaffold,
			);
			if (edited === undefined) return;
			const workflow = await resolveWorkflow(ctx, name, "project", "workflow");
			if (existsSync(workflow.path)) {
				const ok = await ctx.ui.confirm("Overwrite existing workflow?", `${workflow.name}\n${workflow.path}`);
				if (!ok) return;
			}
			await ensureDir(path.dirname(workflow.path));
			await fs.writeFile(workflow.path, edited, "utf8");
			notify(ctx, `Wrote ${workflow.path}${pattern ? ` from pattern ${pattern.key}` : ""}`, "info");
			return;
		}

		if (action === "show" || action === "edit" || action === "open") {
			const name = commandName;
			if (!name) {
				notify(ctx, "Usage: /workflow edit <name>", "warning");
				return;
			}
			if (!ctx.hasUI) {
				const workflow = await resolveWorkflow(ctx, name, "auto");
				const code = await fs.readFile(workflow.path, "utf8");
				notify(ctx, code, "info");
				return;
			}
			const workflow = await resolveWorkflow(ctx, name, "auto");
			const code = await fs.readFile(workflow.path, "utf8");
			const edited = await ctx.ui.editor(`${workflow.name} (${workflow.scope})`, code);
			if (edited !== undefined && edited !== code) {
				await fs.writeFile(workflow.path, edited, "utf8");
				notify(ctx, `Saved ${workflow.path}`, "info");
			}
			return;
		}

		if (action === "run") {
			const name = commandName;
			if (!name) {
				notify(ctx, "Usage: /workflow run <name> [json-input]", "warning");
				return;
			}
			const jsonText = trailingText.trim();
			const input = parseCliJsonOrText(jsonText);
			const workflow = await resolveWorkflow(ctx, name, "auto");
			const limits = buildLimits(limitParamsFromInput(input));
			if (shouldLaunchWorkflowInBackground(ctx)) {
				const status = await startWorkflowBackground(pi, ctx, workflow, input, limits);
				notify(ctx, formatBackgroundStart(status), "info");
				return;
			}
			let lastLogs: WorkflowLogEntry[] = [];
			const result = await runWorkflowWithUi(pi, ctx, workflow, input, limits, undefined, (logs) => {
				lastLogs = logs;
			});
			notify(ctx, formatRunSummary(result), result.ok ? "info" : "error");
			if (lastLogs.length === 0) notify(ctx, "Workflow produced no logs.", "warning");
			return;
		}

		if (action === "start" || action === "bg" || action === "background") {
			const name = commandName;
			if (!name) {
				notify(ctx, "Usage: /workflow start <name> [json-input]", "warning");
				return;
			}
			const jsonText = trailingText.trim();
			const input = parseCliJsonOrText(jsonText);
			const workflow = await resolveWorkflow(ctx, name, "auto");
			const limits = buildLimits(limitParamsFromInput(input));
			const status = await startWorkflowBackground(pi, ctx, workflow, input, limits);
			notify(ctx, formatBackgroundStart(status), "info");
			return;
		}

		if (action === "resume") {
			// Tokens después de "resume": <runId> opcional (por defecto es el más reciente) más
			// --force. Las sesiones persistentes se reanudan en segundo plano por defecto; print/json
			// retrocede a primer plano porque ninguna ejecución en segundo plano puede permanecer viva.
			const tokens = afterAction.split(/\s+/).filter(Boolean);
			const background = shouldLaunchWorkflowInBackground(ctx);
			const force = tokens.some((t) => t === "--force" || t === "-f");
			const runId = tokens.find((t) => !t.startsWith("-"));
			const record = await resumeWorkflow(pi, ctx, runId, { background, force });
			if (background) {
				notify(ctx, formatBackgroundStart(record as WorkflowRunStatus), "info");
			} else {
				const result = record as WorkflowRunResult;
				notify(ctx, formatRunSummary(result), result.ok ? "info" : "error");
			}
			return;
		}

		if (action === "cancel" || action === "stop") {
			const message = await cancelWorkflowRun(ctx, commandName);
			notify(ctx, message, "warning");
			return;
		}

		if (action === "cleanup" || action === "prune" || action === "gc") {
			const opts = parseCleanupArgs(afterAction);
			const doSessions = opts.target === "sessions" || opts.target === "both" || opts.target === "all";
			const doRuns = opts.target === "runs" || opts.target === "both" || opts.target === "all";
			const doDrafts = opts.target === "drafts" || opts.target === "all";
			const doTmp = opts.target === "tmp" || opts.target === "all";

			// Dry-run: previsualiza a través de los selectores puros sin eliminar nada.
			if (opts.dryRun) {
				const lines = ["/workflow cleanup --dry-run — nothing was deleted."];
				if (doSessions) {
					const preview = await prunePiSessionFiles(ctx, {
						includeHeartbeatStale: opts.includeHeartbeatStale,
						dryRun: true,
					});
					lines.push(`Stale session files to remove: ${preview.removed.length} (keeping ${preview.kept})`);
					for (const item of preview.items) {
						lines.push(`  - sessions ${item.action}: ${item.file} — ${item.reason}`);
					}
				}
				if (doRuns) {
					const runItems = await inventoryWorkflowRuns(ctx, { keep: opts.keep });
					const removed = runItems.filter((item) => item.action === "delete").length;
					lines.push(
						`Terminal runs to remove: ${removed} (keeping ${runItems.length - removed}, keep=${opts.keep})`,
					);
					lines.push(...formatCleanupInventory(runItems));
				}
				if (doDrafts) {
					const preview = await cleanupWorkflowDrafts(ctx, { olderThanMs: opts.olderThanMs, dryRun: true });
					lines.push(`Draft files to remove: ${preview.removed.length} (keeping ${preview.kept})`);
					lines.push(...formatCleanupInventory(preview.items));
				}
				if (doTmp) {
					const preview = await cleanupWorkflowTmp(ctx, { olderThanMs: opts.olderThanMs, dryRun: true });
					lines.push(`Tmp entries to remove: ${preview.removed.length} (keeping ${preview.kept})`);
					lines.push(...formatCleanupInventory(preview.items));
				}
				await showText(ctx, "Workflow cleanup (dry run)", lines.join("\n"));
				return;
			}

			// Destructivo: requiere confirmación interactiva, o un --yes explícito en modo sin UI.
			if (!ctx.hasUI && !opts.yes) {
				notify(ctx, "/workflow cleanup is destructive; pass --yes (or --dry-run) in no-UI mode.", "warning");
				return;
			}
			if (ctx.hasUI && !opts.yes) {
				const scope = [
					doSessions ? "stale session files" : "",
					doRuns ? `terminal runs (keep last ${opts.keep})` : "",
					doDrafts ? `old unused drafts (older than ${Math.round(opts.olderThanMs / 3_600_000)}h)` : "",
					doTmp ? `old .pi/tmp entries (older than ${Math.round(opts.olderThanMs / 3_600_000)}h)` : "",
				]
					.filter(Boolean)
					.join(" and ");
				const ok = await ctx.ui.confirm(
					"Run workflow cleanup?",
					`This permanently deletes ${scope}${opts.includeHeartbeatStale ? " (including heartbeat-stale sessions)" : ""}.\n\nActive runs and the current session are never touched. Use --dry-run to preview.`,
				);
				if (!ok) return;
			}

			const summary: string[] = [];
			if (doSessions) {
				const res = await prunePiSessionFiles(ctx, { includeHeartbeatStale: opts.includeHeartbeatStale });
				summary.push(`Removed ${res.removed.length} stale session file(s); kept ${res.kept}.`);
			}
			if (doDrafts) {
				// Draft usage is derived from the current run store. Run draft cleanup before run cleanup so
				// `cleanup all` cannot cascade from "delete old runs" into "now this draft looks unused".
				const res = await cleanupWorkflowDrafts(ctx, { olderThanMs: opts.olderThanMs });
				summary.push(`Removed ${res.removed.length} old unused draft file(s); kept ${res.kept}.`);
			}
			if (doRuns) {
				const res = await cleanupWorkflowRuns(ctx, { keep: opts.keep });
				summary.push(`Removed ${res.removed.length} terminal run(s); kept ${res.kept} (keep=${opts.keep}).`);
			}
			if (doTmp) {
				const res = await cleanupWorkflowTmp(ctx, { olderThanMs: opts.olderThanMs });
				summary.push(`Removed ${res.removed.length} old tmp entr(y/ies); kept ${res.kept}.`);
			}
			notify(ctx, summary.join("\n"), "info");
			return;
		}

		if (action === "delete-run" || action === "rm-run" || action === "delete-run-artifacts") {
			const run = await resolveRun(ctx, commandName);
			if (canCancelRun(run)) {
				notify(ctx, `Run is still active; cancel it before deleting artifacts: ${run.runId}`, "warning");
				return;
			}
			if (!ctx.hasUI) {
				notify(ctx, "/workflow delete-run requires interactive confirmation; refusing in no-UI mode.", "warning");
				return;
			}
			const ok = await ctx.ui.confirm(
				"Delete workflow run artifacts?",
				`Workflow: ${run.workflow}\nRun: ${run.runId}\nState: ${getRunStatusLabel(run)}\nDirectory: ${run.runDir}\n\nThis permanently deletes this run directory and its artifacts. The workflow file is not deleted.`,
			);
			if (!ok) return;
			const message = await deleteWorkflowRun(ctx, run.runId);
			notify(ctx, message, "warning");
			return;
		}

		if (action === "delete" || action === "rm") {
			const name = commandName;
			if (!name) {
				notify(ctx, "Usage: /workflow delete <name>", "warning");
				return;
			}
			const workflow = await resolveWorkflow(ctx, name, "auto");
			if (!ctx.hasUI) {
				notify(ctx, "/workflow delete requires interactive confirmation; refusing in no-UI mode.", "warning");
				return;
			}
			const ok = await ctx.ui.confirm("Delete workflow?", `${workflow.name}\n${workflow.path}`);
			if (!ok) return;
			await fs.unlink(workflow.path);
			notify(ctx, `Deleted ${workflow.path}`, "info");
			return;
		}

		notify(
			ctx,
			"Usage: /workflow list | dashboard | agents | sessions | patterns | graph <name> | check <name> [json] | runs | view [latest|runId] | new <name> [--pattern=<key>] | edit <name> | run <name> [json] | start <name> [json] | resume [latest|runId] [--force] | cancel [latest|runId] | cleanup [sessions|runs|drafts|tmp|all] [--keep=N] [--older-than=24h] [--all-stale] [--dry-run] [--yes] | delete-run [latest|runId] | delete <name>",
			"warning",
		);
	} catch (err) {
		clearWorkflowWidget(ctx);
		notify(ctx, err instanceof Error ? err.message : String(err), "error");
	}
}

export async function handleWorkflowsCommand(pi: ExtensionAPI, args: string, ctx: ExtensionContext): Promise<void> {
	if (args.trim()) {
		await handleWorkflowCommand(pi, args, ctx);
		return;
	}
	await openWorkflowDashboard(pi, ctx);
}
