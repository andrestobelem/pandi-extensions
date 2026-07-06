/**
 * Orquestación del dashboard — el flujo open/choice de /workflow dashboard, cambio de sesión Pi,
 * draft-from-pattern, quoting de argumentos de comando y la ruta de run foreground
 * runWorkflowWithUi. La capa UI sobre el engine runWorkflow y el componente WorkflowDashboard.
 *
 * Ciclos totalmente diferidos: este módulo instancia WorkflowDashboard y llama al engine,
 * collectors, run-lifecycle y helpers de pi-session solo dentro de cuerpos; index.ts y
 * run-lifecycle.ts importan de vuelta los entry points, y dashboard-down-editor.ts importa desde acá
 * openWorkflowDashboard + los tipos Dashboard{CommandSubmitter,Opener}. Los contratos de workflow
 * cruzan desde types.ts como import type; los pattern/dashboard types cruzan como import type local.
 */
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { showLiveAgentView } from "./agent-view.js";
import { buildLimits, limitParamsFromInput, parseCliJsonOrText } from "./config.js";
import {
	collectWorkflowActivity,
	collectWorkflowAgents,
	deriveWorkflowMonitorModels,
	type WorkflowDashboardResult,
} from "./dashboard-collectors.js";
import { stringify } from "./format.js";
import { runWorkflow } from "./index.js";
import { notify } from "./notify.js";
import type { WorkflowPattern } from "./pattern-scaffolds.js";
import { loadWorkflowPatternCode } from "./pattern-scaffolds.js";
import type { PiSessionModel } from "./pi-session.js";
import { collectPiSessions, prunePiSessionFiles, sessionManagerMetadata } from "./pi-session.js";
import {
	cancelWorkflowRun,
	cleanupWorkflowRuns,
	DEFAULT_CLEANUP_KEEP,
	deleteWorkflowRun,
	formatBackgroundStart,
	shouldLaunchWorkflowInBackground,
	startWorkflowBackground,
} from "./run-lifecycle.js";
import { activeRunCount, listActiveRuns } from "./run-registry.js";
import { getRunStatusLabel } from "./run-state.js";
import {
	canCancelRun,
	clearWorkflowWidget,
	formatRunSummary,
	setWorkflowErrorStatus,
	setWorkflowFinishedStatus,
	setWorkflowRunningStatus,
	setWorkflowWidget,
} from "./run-status-ui.js";
import { listRuns, showRunView } from "./run-view.js";
import type {
	PreparedWorkflowRun,
	RunLimits,
	WorkflowDefinition,
	WorkflowLogEntry,
	WorkflowRunRecord,
	WorkflowRunResult,
	WorkflowRunStatus,
} from "./types.js";
import type { DashboardSelection, WorkflowDashboardTab } from "./workflow-dashboard.js";
import { WorkflowDashboard } from "./workflow-dashboard.js";
import { showWorkflowGraph } from "./workflow-graph.js";
import { ensureDir, listWorkflows, resolveWorkflow, resolveWorkflowForRun } from "./workflow-resolve.js";

export async function runWorkflowWithUi(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	workflow: WorkflowDefinition,
	input: unknown,
	limits: RunLimits,
	signal: AbortSignal | undefined,
	onProgress?: (logs: WorkflowLogEntry[], status?: WorkflowRunStatus) => void,
	prepared?: PreparedWorkflowRun,
): Promise<WorkflowRunResult> {
	if (ctx.hasUI) {
		setWorkflowRunningStatus(ctx, workflow.name, []);
		setWorkflowWidget(ctx, workflow.name, []);
	}
	try {
		const result = await runWorkflow(
			pi,
			ctx,
			workflow,
			input,
			limits,
			signal,
			(logs, status) => {
				onProgress?.(logs, status);
				if (ctx.hasUI) {
					setWorkflowRunningStatus(ctx, workflow.name, logs, status);
					setWorkflowWidget(ctx, workflow.name, logs, status);
				}
			},
			prepared,
		);
		setWorkflowFinishedStatus(ctx, result);
		return result;
	} catch (err) {
		setWorkflowErrorStatus(ctx, workflow.name);
		throw err;
	} finally {
		clearWorkflowWidget(ctx);
	}
}

async function runWorkflowFromUi(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	workflow: WorkflowDefinition,
	input: unknown,
): Promise<WorkflowRunRecord> {
	const limits = buildLimits(limitParamsFromInput(input));
	if (shouldLaunchWorkflowInBackground(ctx)) {
		const status = await startWorkflowBackground(pi, ctx, workflow, input, limits);
		notify(ctx, formatBackgroundStart(status), "info");
		return status;
	}
	const result = await runWorkflowWithUi(pi, ctx, workflow, input, limits, undefined);
	notify(ctx, formatRunSummary(result), result.ok ? "info" : "error");
	return result;
}

async function loadRerunInput(
	ctx: ExtensionContext,
	run: WorkflowRunRecord,
): Promise<{ input: unknown; source: string } | undefined> {
	const inputPath = path.join(run.runDir, "input.json");
	let textValue: string;
	let source = inputPath;
	try {
		textValue = await fs.readFile(inputPath, "utf8");
	} catch {
		const edited = await ctx.ui.editor(`Workflow input JSON: ${run.workflow}`, "{}");
		if (edited === undefined) return undefined;
		textValue = edited;
		source = "editor JSON (input.json missing)";
	}
	try {
		return { input: parseCliJsonOrText(textValue, { strictJson: true }), source };
	} catch {
		const edited = await ctx.ui.editor(`Fix workflow input JSON: ${run.workflow}`, textValue);
		if (edited === undefined) return undefined;
		return { input: parseCliJsonOrText(edited, { strictJson: true }), source: "editor JSON" };
	}
}

export type DashboardCommandSubmitter = (command: string) => void;
export type DashboardOpener = (submitCommand?: DashboardCommandSubmitter) => Promise<void>;

async function createWorkflowDraftFromPattern(
	ctx: ExtensionContext,
	pattern: WorkflowPattern,
): Promise<WorkflowDefinition | undefined> {
	const nameText = await ctx.ui.editor("Workflow name", pattern.defaultName);
	const name = nameText?.trim();
	if (!name) return undefined;
	const code = await loadWorkflowPatternCode(pattern);
	const edited = await ctx.ui.editor(`New workflow from pattern: ${pattern.key}`, code);
	if (edited === undefined) return undefined;
	const workflow = await resolveWorkflow(ctx, name, "project", "draft");
	if (existsSync(workflow.path)) {
		const ok = await ctx.ui.confirm("Overwrite existing workflow?", `${workflow.name}\n${workflow.path}`);
		if (!ok) return undefined;
	}
	await ensureDir(path.dirname(workflow.path));
	await fs.writeFile(workflow.path, edited, "utf8");
	return workflow;
}

interface WorkflowDashboardOpenOptions {
	submitCommand?: DashboardCommandSubmitter;
}

type SwitchableSessionContext = ExtensionContext & {
	switchSession?: (
		sessionPath: string,
		options?: {
			withSession?: (ctx: {
				ui: { notify?: (message: string, kind?: "info" | "warning" | "error") => void };
			}) => Promise<void> | void;
		},
	) => Promise<{ cancelled: boolean }>;
};

function quoteWorkflowCommandArgument(value: string): string {
	return JSON.stringify(value);
}

export function parseWorkflowCommandArgument(value: string): string | undefined {
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	if (trimmed.startsWith('"')) {
		try {
			const parsed = JSON.parse(trimmed);
			if (typeof parsed === "string") return parsed;
		} catch {
			return undefined;
		}
	}
	return trimmed;
}

export async function switchToPiSession(
	ctx: ExtensionContext,
	session: PiSessionModel,
	options: WorkflowDashboardOpenOptions = {},
): Promise<void> {
	const sessionFile = session.sessionFile;
	if (!sessionFile) {
		notify(ctx, "Cannot switch: selected Pi session did not record a session file.", "warning");
		return;
	}
	const currentFile = sessionManagerMetadata(ctx).sessionFile;
	if (currentFile && path.resolve(currentFile) === path.resolve(sessionFile)) {
		notify(ctx, "Already in the selected Pi session.", "info");
		return;
	}
	const switchSession = (ctx as SwitchableSessionContext).switchSession;
	if (typeof switchSession !== "function") {
		if (options.submitCommand) {
			options.submitCommand(`/workflow switch-session ${quoteWorkflowCommandArgument(sessionFile)}`);
			return;
		}
		notify(
			ctx,
			"Cannot switch from this dashboard context. Open it from the prompt with /workflow sessions.",
			"warning",
		);
		return;
	}
	if (!existsSync(sessionFile)) {
		notify(ctx, `Cannot switch: session file no longer exists: ${sessionFile}`, "warning");
		return;
	}
	const label = session.sessionName || session.sessionId || path.basename(sessionFile);
	const activeWarning =
		activeRunCount() > 0
			? `\n\nWarning: ${activeRunCount()} active workflow run(s) in this Pi will be cancelled by the session switch.`
			: "";
	const pidLine =
		session.pid > 0
			? `\nPID: ${session.pid}${session.live ? " (live)" : session.staleReason ? ` (${session.staleReason})` : ""}`
			: "";
	const ok = await ctx.ui.confirm(
		"Switch Pi session?",
		`Target: ${label}\nFile: ${sessionFile}${pidLine}\n\nThis replaces the current conversation view. If another Pi process is still using this file, both processes may append to the same session.${activeWarning}`,
	);
	if (!ok) return;
	const result = await switchSession(sessionFile, {
		withSession: async (nextCtx) => {
			nextCtx.ui.notify?.(`Switched to Pi session: ${label}`, "info");
		},
	});
	if (result.cancelled) notify(ctx, "Session switch cancelled.", "warning");
}

export async function openWorkflowDashboard(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	initialTab: WorkflowDashboardTab = "monitor",
	options: WorkflowDashboardOpenOptions = {},
): Promise<void> {
	if (ctx.mode !== "tui") {
		notify(
			ctx,
			"Workflow dashboard requires TUI mode. Use /workflow list, /workflow graph, /workflow runs, or /workflow view.",
			"warning",
		);
		return;
	}
	let currentTab = initialTab;
	let restore: DashboardSelection | undefined;
	// Loop de reapertura: las acciones no terminales (view/graph/agent/cancel/delete/rerun/run)
	// vuelven al dashboard en el mismo tab/selección en vez de caer al
	// editor. Solo cambiar de sesión, crear un draft de patrón o q/esc salen.
	for (;;) {
		const workflows = await listWorkflows(ctx);
		const runs = await listRuns(ctx);
		const [activity, piSessions, monitorModels, agentEntries] = await Promise.all([
			collectWorkflowActivity(runs),
			collectPiSessions(ctx),
			deriveWorkflowMonitorModels(runs),
			collectWorkflowAgents(runs),
		]);
		let refreshTimer: NodeJS.Timeout | undefined;
		let refreshing = false;
		let dashboard: WorkflowDashboard | undefined;
		let choice: WorkflowDashboardResult | null = null;
		try {
			choice = await ctx.ui.custom<WorkflowDashboardResult | null>((tui, theme, _keybindings, done) => {
				dashboard = new WorkflowDashboard(
					workflows,
					runs,
					activity,
					piSessions,
					monitorModels,
					agentEntries,
					theme,
					() => tui.requestRender(),
					done,
					currentTab,
					restore,
				);
				const refresh = async () => {
					if (refreshing || !dashboard) return;
					refreshing = true;
					try {
						const nextRuns = await listRuns(ctx);
						const [nextActivity, nextPiSessions, nextMonitorModels, nextAgentEntries] = await Promise.all([
							collectWorkflowActivity(nextRuns),
							collectPiSessions(ctx),
							deriveWorkflowMonitorModels(nextRuns),
							collectWorkflowAgents(nextRuns),
						]);
						dashboard.setRuns(nextRuns);
						dashboard.setActivity(nextActivity);
						dashboard.setPiSessions(nextPiSessions);
						dashboard.setMonitorModels(nextMonitorModels);
						dashboard.setAgentEntries(nextAgentEntries);
						dashboard.markRefreshOk();
						tui.requestRender();
					} catch (err) {
						// Nunca dejes que una falla transitoria de listRuns/read se convierta en una rejection
						// no manejada que congele el dashboard con datos stale y sin señal.
						dashboard?.markRefreshError(err instanceof Error ? err.message : String(err));
						tui.requestRender();
					} finally {
						refreshing = false;
					}
				};
				refreshTimer = setInterval(() => void refresh(), 1500);
				return dashboard;
			});
		} finally {
			if (refreshTimer) clearInterval(refreshTimer);
		}
		if (!choice) return;
		const savedSelection = dashboard?.getSelection();
		const action = await handleDashboardChoice(pi, ctx, choice, options);
		if (action === "close") return;
		currentTab = savedSelection?.tab ?? currentTab;
		restore = savedSelection;
	}
}

async function handleDashboardChoice(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	choice: WorkflowDashboardResult,
	options: WorkflowDashboardOpenOptions,
): Promise<"reopen" | "close"> {
	if (choice.type === "switchSession" && choice.session) {
		await switchToPiSession(ctx, choice.session, options);
		return "close";
	}
	if (choice.type === "newPattern" && choice.pattern) {
		const workflow = await createWorkflowDraftFromPattern(ctx, choice.pattern);
		if (workflow) {
			notify(
				ctx,
				`Wrote ${workflow.path}\nRun it with /workflow start ${workflow.name} ${choice.pattern.inputHint}`,
				"info",
			);
		}
		return "close";
	}
	if (choice.type === "graph") {
		const workflow = choice.workflow ?? (choice.run ? await resolveWorkflowForRun(ctx, choice.run) : undefined);
		if (!workflow) {
			notify(ctx, "Cannot open graph: workflow file not found.", "warning");
			return "reopen";
		}
		const code = await fs.readFile(workflow.path, "utf8");
		await showWorkflowGraph(ctx, workflow, code);
		return "reopen";
	}
	if (choice.type === "agent" && choice.run && choice.agent) {
		await showLiveAgentView(ctx, choice.run, choice.agent);
		return "reopen";
	}
	if (choice.type === "view" && choice.run) {
		await showRunView(ctx, choice.run);
		return "reopen";
	}
	if (choice.type === "cancel" && choice.run) {
		const ok = await ctx.ui.confirm(
			"Cancel workflow run?",
			`Workflow: ${choice.run.workflow}\nRun: ${choice.run.runId}\n\nThis aborts the active background run. Artifacts already written remain on disk.`,
		);
		if (ok) {
			const message = await cancelWorkflowRun(ctx, choice.run.runId);
			notify(ctx, message, "warning");
		}
		return "reopen";
	}
	if (choice.type === "cleanup") {
		const target = choice.cleanupTarget ?? "runs";
		if (target === "sessions") {
			const preview = await prunePiSessionFiles(ctx, { dryRun: true });
			if (preview.removed.length === 0) {
				notify(ctx, "No stale session files to clean up.", "info");
				return "reopen";
			}
			const ok = await ctx.ui.confirm(
				"Clean up stale session files?",
				`This removes ${preview.removed.length} stale Pi session file(s) whose process has exited. Live and current sessions are never touched.`,
			);
			if (ok) {
				const res = await prunePiSessionFiles(ctx);
				notify(ctx, `Removed ${res.removed.length} stale session file(s); kept ${res.kept}.`, "info");
			}
			return "reopen";
		}
		const preview = await cleanupWorkflowRuns(ctx, { dryRun: true });
		if (preview.removed.length === 0) {
			notify(ctx, `No terminal runs to clean up (keeping the ${DEFAULT_CLEANUP_KEEP} most recent).`, "info");
			return "reopen";
		}
		const ok = await ctx.ui.confirm(
			"Clean up terminal workflow runs?",
			`This permanently deletes ${preview.removed.length} terminal run director(ies), keeping the ${DEFAULT_CLEANUP_KEEP} most recent. Running and active runs are never touched.`,
		);
		if (ok) {
			const res = await cleanupWorkflowRuns(ctx);
			notify(ctx, `Removed ${res.removed.length} terminal run(s); kept ${res.kept}.`, "info");
		}
		return "reopen";
	}
	if (choice.type === "deleteRun" && choice.run) {
		if (canCancelRun(choice.run)) {
			notify(ctx, `Run is still active; cancel it before deleting artifacts: ${choice.run.runId}`, "warning");
			return "reopen";
		}
		const ok = await ctx.ui.confirm(
			"Delete workflow run artifacts?",
			`Workflow: ${choice.run.workflow}\nRun: ${choice.run.runId}\nState: ${getRunStatusLabel(choice.run)}\nDirectory: ${choice.run.runDir}\n\nThis permanently deletes this run directory and its artifacts. The workflow file is not deleted.`,
		);
		if (ok) {
			const message = await deleteWorkflowRun(ctx, choice.run.runId);
			notify(ctx, message, "warning");
		}
		return "reopen";
	}
	if (choice.type === "deleteWorkflow" && choice.workflow) {
		const activeForWorkflow = listActiveRuns().filter(
			(run) =>
				run.workflowDefinition.path === choice.workflow?.path ||
				run.workflowDefinition.name === choice.workflow?.name,
		);
		const ok = await ctx.ui.confirm(
			"Delete workflow?",
			`Workflow: ${choice.workflow.name}\nScope: ${choice.workflow.scope}\nPath: ${choice.workflow.path}\n\nThis deletes only the workflow file, not previous run artifacts.${activeForWorkflow.length ? `\n\nWarning: ${activeForWorkflow.length} active run(s) from this workflow will keep running unless cancelled.` : ""}`,
		);
		if (ok) {
			await fs.unlink(choice.workflow.path);
			notify(ctx, `Deleted workflow ${choice.workflow.name}: ${choice.workflow.path}`, "info");
		}
		return "reopen";
	}
	if (choice.type === "rerun" && choice.run) {
		if (canCancelRun(choice.run)) {
			notify(ctx, `Run is still active; cancel or wait before rerunning: ${choice.run.runId}`, "warning");
			return "reopen";
		}
		const workflow = await resolveWorkflowForRun(ctx, choice.run);
		if (!workflow) {
			notify(ctx, "Cannot rerun: workflow file not found.", "warning");
			return "reopen";
		}
		const loaded = await loadRerunInput(ctx, choice.run);
		if (loaded) {
			const ok = await ctx.ui.confirm(
				"Rerun workflow?",
				`Workflow: ${workflow.name}\nFrom run: ${choice.run.runId}\nInput: ${loaded.source}\n\n${stringify(loaded.input, 1200)}`,
			);
			if (ok) await runWorkflowFromUi(pi, ctx, workflow, loaded.input);
		}
		return "reopen";
	}
	if (choice.type === "run" && choice.workflow) {
		const inputText = await ctx.ui.editor("Workflow input JSON", "{}");
		if (inputText !== undefined) {
			const input = parseCliJsonOrText(inputText, { strictJson: true });
			const ok = await ctx.ui.confirm(
				"Run workflow?",
				`Workflow: ${choice.workflow.name}\n\n${stringify(input, 1200)}`,
			);
			if (ok) await runWorkflowFromUi(pi, ctx, choice.workflow, input);
		}
		return "reopen";
	}
	return "close";
}
