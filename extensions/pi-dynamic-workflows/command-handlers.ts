/**
 * Command/tool handlers — the dispatch bodies behind the dynamic_workflow tool and the
 * /workflow + /workflows commands. The thin glue between the activate registrations and
 * the engine / lifecycle / orchestration / ultracode layers.
 *
 * Fully-deferred cycle: every collaborator is called inside a handler body, so index.ts
 * imports the three entry points back and the activate body wires them into
 * registerTool/registerCommand. Imports filled in from the gate (typecheck + eslint).
 * Extracted byte-identically.
 */
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { buildLimits, limitParamsFromInput, normalizeWorkflowInput, parseCliJsonOrText } from "./config.js";
import {
	cancelWorkflowRun,
	deleteWorkflowRun,
	formatBackgroundStart,
	resumeWorkflow,
	shouldLaunchWorkflowInBackground,
	startWorkflowBackground,
} from "./run-lifecycle.js";
import { collectPiSessions, formatPiSessionList } from "./pi-session.js";
import { formatRunList, formatRunView, listRuns, resolveRun } from "./run-view.js";
import { formatWorkflowList } from "./presentation.js";
import {
	formatWorkflowPatternCatalog,
	loadWorkflowPatternCode,
	resolveWorkflowPattern,
	WORKFLOW_PATTERN_CATALOG,
	WORKFLOW_TEMPLATE,
} from "./templates.js";
import { getRunStatusLabel } from "./run-state.js";
import { makeWorkflowGraphForContext } from "./workflow-graph.js";
import { notify } from "./notify.js";
import { text } from "./format.js";
import {
	openWorkflowDashboard,
	parseWorkflowCommandArgument,
	runWorkflowWithUi,
	switchToPiSession,
} from "./dashboard-orchestration.js";
import { currentWorkflowDepth, maxWorkflowDepth } from "./index.js";
import { ensureDir, listWorkflows, parsePatternFlag, resolveWorkflow } from "./workflow-resolve.js";
import { canCancelRun, clearWorkflowWidget, formatRunSummary, showText } from "./run-status-ui.js";
import { showWorkflowGraph } from "./workflow-graph.js";
import type { DynamicWorkflowToolParams, WorkflowLogEntry, WorkflowRunResult, WorkflowRunStatus } from "./index.js";
import type { AgentToolUpdateCallback, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export async function handleTool(
	pi: ExtensionAPI,
	params: DynamicWorkflowToolParams,
	signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback | undefined,
	ctx: ExtensionContext,
) {
	const action = params.action;
	const scope = params.scope ?? "auto";

	// Recursion guard: a workflow subagent (depth >= limit) may not launch more workflows.
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

	if (action === "template") {
		const pattern = params.name ? resolveWorkflowPattern(params.name) : undefined;
		if (params.name && !pattern) {
			throw new Error(
				`Unknown workflow pattern: ${params.name}. Available: ${WORKFLOW_PATTERN_CATALOG.map((item) => item.key).join(", ")}`,
			);
		}
		if (pattern) {
			const template = await loadWorkflowPatternCode(pattern);
			return { content: [text(template)], details: { action, pattern, template } };
		}
		return {
			content: [text(formatWorkflowPatternCatalog())],
			details: { action, patterns: WORKFLOW_PATTERN_CATALOG, template: WORKFLOW_TEMPLATE },
		};
	}

	if (action === "list") {
		const workflows = await listWorkflows(ctx);
		return { content: [text(formatWorkflowList(workflows))], details: { action, workflows } };
	}

	if (action === "runs") {
		const runs = await listRuns(ctx);
		return { content: [text(formatRunList(runs))], details: { action, runs } };
	}

	if (action === "view") {
		const run = await resolveRun(ctx, params.name);
		const view = await formatRunView(run);
		return { content: [text(view)], details: { action, run } };
	}

	if (action === "cancel") {
		const message = await cancelWorkflowRun(ctx, params.name);
		return { content: [text(message)], details: { action, message } };
	}

	if (action === "resume") {
		const resumeInBackground = shouldLaunchWorkflowInBackground(ctx);
		const record = await resumeWorkflow(
			pi,
			ctx,
			params.name,
			{ background: resumeInBackground, force: !!params.force },
			signal,
			(logs) => {
				const preview = logs
					.slice(-8)
					.map((entry) => `${entry.time.slice(11, 19)} ${entry.message}`)
					.join("\n");
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

	if (!params.name) throw new Error(`dynamic_workflow action=${action} requires name.`);

	if (action === "read") {
		const workflow = await resolveWorkflow(ctx, params.name, scope);
		const code = await fs.readFile(workflow.path, "utf8");
		return { content: [text(code)], details: { action, workflow, code } };
	}

	if (action === "graph") {
		const workflow = await resolveWorkflow(ctx, params.name, scope);
		const code = await fs.readFile(workflow.path, "utf8");
		const graph = await makeWorkflowGraphForContext(ctx, workflow, code);
		return { content: [text(graph)], details: { action, workflow, graph } };
	}

	if (action === "write") {
		if (params.code === undefined) throw new Error("dynamic_workflow action=write requires code.");
		const workflow = await resolveWorkflow(ctx, params.name, scope, "draft");
		await ensureDir(path.dirname(workflow.path));
		await fs.writeFile(workflow.path, params.code, "utf8");
		return {
			content: [text(`Wrote workflow ${workflow.name} (${workflow.scope}) to ${workflow.path}`)],
			details: { action, workflow },
		};
	}

	if (action === "delete") {
		const workflow = await resolveWorkflow(ctx, params.name, scope);
		if (!ctx.hasUI) throw new Error("Deleting workflows requires interactive confirmation.");
		const ok = await ctx.ui.confirm("Delete workflow?", `${workflow.name}\n${workflow.path}`);
		if (!ok) throw new Error("Workflow deletion cancelled.");
		await fs.unlink(workflow.path);
		return {
			content: [text(`Deleted workflow ${workflow.name} (${workflow.scope}) from ${workflow.path}`)],
			details: { action, workflow },
		};
	}

	if (action === "start" || (action === "run" && shouldLaunchWorkflowInBackground(ctx))) {
		const workflow = await resolveWorkflow(ctx, params.name, scope);
		const workflowInput = normalizeWorkflowInput(params.input);
		const limits = buildLimits({ ...limitParamsFromInput(workflowInput), ...params });
		const status = await startWorkflowBackground(pi, ctx, workflow, workflowInput, limits);
		return {
			content: [text(formatBackgroundStart(status))],
			details: { action, workflow, status },
		};
	}

	if (action === "run") {
		const workflow = await resolveWorkflow(ctx, params.name, scope);
		const workflowInput = normalizeWorkflowInput(params.input);
		const limits = buildLimits({ ...limitParamsFromInput(workflowInput), ...params });
		const result = await runWorkflowWithUi(pi, ctx, workflow, workflowInput, limits, signal, (logs) => {
			const preview = logs
				.slice(-8)
				.map((entry) => `${entry.time.slice(11, 19)} ${entry.message}`)
				.join("\n");
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

		if (action === "patterns" || action === "catalog" || action === "templates") {
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

		if (action === "runs") {
			await showText(ctx, "Workflow runs", formatRunList(await listRuns(ctx)));
			return;
		}

		if (action === "view") {
			const run = await resolveRun(ctx, commandName);
			await showText(ctx, `Workflow run: ${run.runId}`, await formatRunView(run));
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
			const template = pattern ? await loadWorkflowPatternCode(pattern) : WORKFLOW_TEMPLATE;
			const edited = await ctx.ui.editor(
				pattern ? `New workflow: ${name} (${pattern.key})` : `New workflow: ${name}`,
				template,
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
			// Tokens after "resume": optional <runId> (defaults to latest) plus
			// --force. Persistent sessions resume in background by default; print/json
			// falls back to foreground because no background run can stay alive.
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

		if (action === "delete-run" || action === "rm-run" || action === "delete-run-artifacts") {
			const run = await resolveRun(ctx, commandName);
			if (canCancelRun(run)) {
				notify(ctx, `Run is still active; cancel it before deleting artifacts: ${run.runId}`, "warning");
				return;
			}
			if (!ctx.hasUI) {
				notify(
					ctx,
					"/workflow delete-run requires interactive confirmation; refusing in no-UI mode.",
					"warning",
				);
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
			"Usage: /workflow list | dashboard | agents | sessions | patterns | graph <name> | runs | view [latest|runId] | new <name> [--pattern=<key>] | edit <name> | run <name> [json] | start <name> [json] | resume [latest|runId] [--force] | cancel [latest|runId] | delete-run [latest|runId] | delete <name>",
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
