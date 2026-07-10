import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { CONFIG_DIR_NAME, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { parseCliJsonOrText } from "../lib/config.js";
import { notify } from "../lib/notify.js";
import { formatDraftUsageIndex, formatWorkflowList } from "../lib/presentation.js";
import { writeRunReport } from "../observe/index.js";
import { collectPiSessions, formatPiSessionList } from "../pi-session.js";
import { getRunState } from "../runtime/index.js";
import { showWorkflowGraph } from "../tui/graph/index.js";
import {
	formatRunList,
	listRuns,
	openWorkflowDashboard,
	parseWorkflowCommandArgument,
	resolveRun,
	showRunView,
	showText,
	switchToPiSession,
} from "../tui/index.js";
import { parseRunReportArgs } from "./command-parsers.js";
import {
	formatWorkflowPatternCatalog,
	getDefaultScaffold,
	loadWorkflowPatternCode,
	resolveWorkflowPattern,
	WORKFLOW_PATTERN_CATALOG,
} from "./pattern-scaffolds.js";
import { formatWorkflowPreflightSummary, preflightWorkflowLaunch } from "./preflight.js";
import { ensureDir, listWorkflows, parsePatternFlag, resolveWorkflow, WORKFLOW_DRAFT_DIR } from "./resolve.js";

export type WorkflowCommandParsed = {
	action: string;
	afterAction: string;
	commandName: string | undefined;
	trailingText: string;
};

/** Returns true if the action was handled. */
export async function handleBrowseWorkflowCommand(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	parsed: WorkflowCommandParsed,
): Promise<boolean> {
	const { action, afterAction, commandName, trailingText } = parsed;

	if (action === "list" || action === "ls") {
		notify(ctx, formatWorkflowList(await listWorkflows(ctx)), "info");
		return true;
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
		return true;
	}

	if (action === "dashboard" || action === "tui") {
		await openWorkflowDashboard(pi, ctx);
		return true;
	}

	if (action === "agents" || action === "agent") {
		await openWorkflowDashboard(pi, ctx, "agents");
		return true;
	}

	if (action === "sessions" || action === "session") {
		if (ctx.mode === "tui") await openWorkflowDashboard(pi, ctx, "sessions");
		else await showText(ctx, "Pi sessions", formatPiSessionList(await collectPiSessions(ctx)));
		return true;
	}

	if (action === "switch-session") {
		const sessionFile = parseWorkflowCommandArgument(afterAction);
		if (!sessionFile) {
			notify(ctx, "Usage: /workflow switch-session <session-file>", "warning");
			return true;
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
		return true;
	}

	if (action === "patterns" || action === "catalog" || action === "scaffolds") {
		if (ctx.mode === "tui") await openWorkflowDashboard(pi, ctx, "patterns");
		else await showText(ctx, "Workflow pattern catalog", formatWorkflowPatternCatalog());
		return true;
	}

	if (action === "graph" || action === "viz") {
		const name = commandName;
		if (!name) {
			notify(ctx, "Usage: /workflow graph <name>", "warning");
			return true;
		}
		const workflow = await resolveWorkflow(ctx, name, "auto");
		const code = await fs.readFile(workflow.path, "utf8");
		await showWorkflowGraph(ctx, workflow, code);
		return true;
	}

	if (action === "check") {
		const name = commandName;
		if (!name) {
			notify(ctx, "Usage: /workflow check <name> [json-input]", "warning");
			return true;
		}
		const workflow = await resolveWorkflow(ctx, name, "auto");
		const input = parseCliJsonOrText(trailingText.trim());
		const preflight = await preflightWorkflowLaunch(ctx, workflow, input);
		notify(ctx, formatWorkflowPreflightSummary(preflight), "info");
		return true;
	}

	if (action === "runs") {
		await showText(ctx, "Workflow runs", formatRunList(await listRuns(ctx)));
		return true;
	}

	if (action === "view") {
		const run = await resolveRun(ctx, commandName);
		await showRunView(ctx, run);
		return true;
	}

	if (action === "report") {
		// /workflow report [runId|latest] [--watch] [-o out.html] — default output is
		// INSIDE the run dir so relative artifact links resolve; -o elsewhere breaks
		// those links, so it warns.
		const reportArgs = parseRunReportArgs(afterAction);
		if (reportArgs.missingOutPath) {
			notify(ctx, "Usage: /workflow report [runId|latest] [--watch] [-o out.html]", "warning");
			return true;
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
		return true;
	}

	if (action === "new" || action === "create") {
		const name = commandName;
		if (!name) {
			notify(ctx, "Usage: /workflow new <name> [--pattern=<key>]", "warning");
			return true;
		}
		if (!ctx.hasUI) {
			notify(
				ctx,
				"/workflow new requires interactive UI. Use dynamic_workflow action=write in agent mode.",
				"warning",
			);
			return true;
		}
		const patternKey = parsePatternFlag(trailingText);
		const pattern = patternKey ? resolveWorkflowPattern(patternKey) : undefined;
		if (patternKey && !pattern) {
			notify(
				ctx,
				`Unknown workflow pattern: ${patternKey}. Available: ${WORKFLOW_PATTERN_CATALOG.map((item) => item.key).join(", ")}`,
				"warning",
			);
			return true;
		}
		const scaffold = pattern ? await loadWorkflowPatternCode(pattern) : getDefaultScaffold();
		const edited = await ctx.ui.editor(
			pattern ? `New workflow: ${name} (${pattern.key})` : `New workflow: ${name}`,
			scaffold,
		);
		if (edited === undefined) return true;
		const workflow = await resolveWorkflow(ctx, name, "project", "workflow");
		if (existsSync(workflow.path)) {
			const ok = await ctx.ui.confirm("Overwrite existing workflow?", `${workflow.name}\n${workflow.path}`);
			if (!ok) return true;
		}
		await ensureDir(path.dirname(workflow.path));
		await fs.writeFile(workflow.path, edited, "utf8");
		notify(ctx, `Wrote ${workflow.path}${pattern ? ` from pattern ${pattern.key}` : ""}`, "info");
		return true;
	}

	if (action === "show" || action === "edit" || action === "open") {
		const name = commandName;
		if (!name) {
			notify(ctx, "Usage: /workflow edit <name>", "warning");
			return true;
		}
		if (!ctx.hasUI) {
			const workflow = await resolveWorkflow(ctx, name, "auto");
			const code = await fs.readFile(workflow.path, "utf8");
			notify(ctx, code, "info");
			return true;
		}
		const workflow = await resolveWorkflow(ctx, name, "auto");
		const code = await fs.readFile(workflow.path, "utf8");
		const edited = await ctx.ui.editor(`${workflow.name} (${workflow.scope})`, code);
		if (edited !== undefined && edited !== code) {
			await fs.writeFile(workflow.path, edited, "utf8");
			notify(ctx, `Saved ${workflow.path}`, "info");
		}
		return true;
	}

	return false;
}
