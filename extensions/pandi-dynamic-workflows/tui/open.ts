/**
 * Apertura del dashboard y dispatch de acciones — el loop open/choice de /workflow dashboard
 * y handleDashboardChoice. Instancia WorkflowDashboard, refresca collectors en intervalo y
 * delega cada selección a la acción correspondiente (view, graph, run, cleanup, etc.).
 */
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildLimits, limitParamsFromInput, parseCliJsonOrText } from "../lib/config.js";
import { stringify } from "../lib/format.js";
import { notify } from "../lib/notify.js";
import {
	cancelWorkflowRun,
	cleanupWorkflowRuns,
	DEFAULT_CLEANUP_KEEP,
	deleteWorkflowRun,
	formatBackgroundStart,
	listActiveRuns,
	shouldLaunchWorkflowInBackground,
	startWorkflowBackground,
} from "../lifecycle/index.js";
import { collectPiSessions, prunePiSessionFiles } from "../pi-session.js";
import { getRunStatusLabel } from "../runtime/index.js";
import type { WorkflowPattern } from "../surface/index.js";
import {
	ensureDir,
	listWorkflows,
	loadWorkflowPatternCode,
	resolveWorkflow,
	resolveWorkflowForRun,
} from "../surface/index.js";
import type { WorkflowDefinition, WorkflowRunRecord } from "../types.js";
import { showLiveAgentView } from "./agent-view.js";
import {
	collectWorkflowActivity,
	collectWorkflowAgents,
	deriveWorkflowMonitorModels,
	type WorkflowDashboardResult,
} from "./collectors.js";
import type { DashboardSelection, WorkflowDashboardTab } from "./dashboard.js";
import { WorkflowDashboard } from "./dashboard.js";
import { showWorkflowGraph } from "./graph/index.js";
import type { WorkflowDashboardOpenOptions } from "./orchestration.js";
import { runWorkflowWithUi, switchToPiSession } from "./orchestration.js";
import { listRuns, showRunView } from "./run-view.js";
import { canCancelRun, formatRunSummary } from "./status-ui.js";

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
		const edited = await ctx.ui.editor(`JSON de input del workflow: ${run.workflow}`, "{}");
		if (edited === undefined) return undefined;
		textValue = edited;
		source = "JSON del editor (falta input.json)";
	}
	try {
		return { input: parseCliJsonOrText(textValue, { strictJson: true }), source };
	} catch {
		const edited = await ctx.ui.editor(`Corregí el JSON de input del workflow: ${run.workflow}`, textValue);
		if (edited === undefined) return undefined;
		return { input: parseCliJsonOrText(edited, { strictJson: true }), source: "JSON del editor" };
	}
}

async function createWorkflowDraftFromPattern(
	ctx: ExtensionContext,
	pattern: WorkflowPattern,
): Promise<WorkflowDefinition | undefined> {
	const nameText = await ctx.ui.editor("Nombre del workflow", pattern.defaultName);
	const name = nameText?.trim();
	if (!name) return undefined;
	const code = await loadWorkflowPatternCode(pattern);
	const edited = await ctx.ui.editor(`Workflow nuevo desde el pattern: ${pattern.key}`, code);
	if (edited === undefined) return undefined;
	const workflow = await resolveWorkflow(ctx, name, "project", "draft");
	if (existsSync(workflow.path)) {
		const ok = await ctx.ui.confirm("¿Sobrescribir el workflow existente?", `${workflow.name}\n${workflow.path}`);
		if (!ok) return undefined;
	}
	await ensureDir(path.dirname(workflow.path));
	await fs.writeFile(workflow.path, edited, "utf8");
	return workflow;
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
			"El dashboard de workflows requiere modo TUI. Usá /workflow list, /workflow graph, /workflow runs o /workflow view.",
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
				`Se escribió ${workflow.path}\nCorrélo con /workflow start ${workflow.name} ${choice.pattern.inputHint}`,
				"info",
			);
		}
		return "close";
	}
	if (choice.type === "graph") {
		const workflow = choice.workflow ?? (choice.run ? await resolveWorkflowForRun(ctx, choice.run) : undefined);
		if (!workflow) {
			notify(ctx, "No se puede abrir el graph: no se encontró el archivo del workflow.", "warning");
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
			"¿Cancelar el workflow run?",
			`Workflow: ${choice.run.workflow}\nRun: ${choice.run.runId}\n\nEsto aborta el run activo en background. Los artifacts ya escritos quedan en disco.`,
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
				notify(ctx, "No hay archivos de sesión stale para limpiar.", "info");
				return "reopen";
			}
			const ok = await ctx.ui.confirm(
				"¿Limpiar archivos de sesión stale?",
				`Esto elimina ${preview.removed.length} archivo(s) de sesión de Pi stale cuyo proceso ya salió. Las sesiones live y la actual nunca se tocan.`,
			);
			if (ok) {
				const res = await prunePiSessionFiles(ctx);
				notify(
					ctx,
					`Se eliminaron ${res.removed.length} archivo(s) de sesión stale; se conservaron ${res.kept}.`,
					"info",
				);
			}
			return "reopen";
		}
		const preview = await cleanupWorkflowRuns(ctx, { dryRun: true });
		if (preview.removed.length === 0) {
			notify(
				ctx,
				`No hay runs terminales para limpiar (se conservan los ${DEFAULT_CLEANUP_KEEP} más recientes).`,
				"info",
			);
			return "reopen";
		}
		const ok = await ctx.ui.confirm(
			"¿Limpiar workflow runs terminales?",
			`Esto elimina de forma permanente ${preview.removed.length} directorio(s) de runs terminales y conserva los ${DEFAULT_CLEANUP_KEEP} más recientes. Los runs running y activos nunca se tocan.`,
		);
		if (ok) {
			const res = await cleanupWorkflowRuns(ctx);
			notify(ctx, `Se eliminaron ${res.removed.length} run(s) terminales; se conservaron ${res.kept}.`, "info");
		}
		return "reopen";
	}
	if (choice.type === "deleteRun" && choice.run) {
		if (canCancelRun(choice.run)) {
			notify(ctx, `El run sigue activo; cancelalo antes de borrar artifacts: ${choice.run.runId}`, "warning");
			return "reopen";
		}
		const ok = await ctx.ui.confirm(
			"¿Borrar los artifacts del workflow run?",
			`Workflow: ${choice.run.workflow}\nRun: ${choice.run.runId}\nState: ${getRunStatusLabel(choice.run)}\nDirectory: ${choice.run.runDir}\n\nEsto elimina de forma permanente este directorio de run y sus artifacts. El archivo del workflow no se borra.`,
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
			"¿Borrar el workflow?",
			`Workflow: ${choice.workflow.name}\nScope: ${choice.workflow.scope}\nPath: ${choice.workflow.path}\n\nEsto borra solo el archivo del workflow, no los artifacts de runs previos.${activeForWorkflow.length ? `\n\nAdvertencia: ${activeForWorkflow.length} run(s) activos de este workflow seguirán corriendo salvo que se cancelen.` : ""}`,
		);
		if (ok) {
			await fs.unlink(choice.workflow.path);
			notify(ctx, `Se borró el workflow ${choice.workflow.name}: ${choice.workflow.path}`, "info");
		}
		return "reopen";
	}
	if (choice.type === "rerun" && choice.run) {
		if (canCancelRun(choice.run)) {
			notify(ctx, `El run sigue activo; cancelalo o esperá antes de relanzarlo: ${choice.run.runId}`, "warning");
			return "reopen";
		}
		const workflow = await resolveWorkflowForRun(ctx, choice.run);
		if (!workflow) {
			notify(ctx, "No se puede relanzar: no se encontró el archivo del workflow.", "warning");
			return "reopen";
		}
		const loaded = await loadRerunInput(ctx, choice.run);
		if (loaded) {
			const ok = await ctx.ui.confirm(
				"¿Relanzar el workflow?",
				`Workflow: ${workflow.name}\nDesde run: ${choice.run.runId}\nInput: ${loaded.source}\n\n${stringify(loaded.input, 1200)}`,
			);
			if (ok) await runWorkflowFromUi(pi, ctx, workflow, loaded.input);
		}
		return "reopen";
	}
	if (choice.type === "run" && choice.workflow) {
		const inputText = await ctx.ui.editor("JSON de input del workflow", "{}");
		if (inputText !== undefined) {
			const input = parseCliJsonOrText(inputText, { strictJson: true });
			const ok = await ctx.ui.confirm(
				"¿Correr el workflow?",
				`Workflow: ${choice.workflow.name}\n\n${stringify(input, 1200)}`,
			);
			if (ok) await runWorkflowFromUi(pi, ctx, choice.workflow, input);
		}
		return "reopen";
	}
	return "close";
}
