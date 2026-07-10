/**
 * Orquestación del dashboard — cambio de sesión Pi, draft-from-pattern helpers compartidos,
 * quoting de argumentos de comando y la ruta de run foreground runWorkflowWithUi.
 * La capa UI sobre el engine runWorkflow y el componente WorkflowDashboard vive en dashboard-open.ts.
 *
 * Ciclos totalmente diferidos: run-lifecycle.ts importa runWorkflowWithUi; dashboard-open.ts importa
 * switchToPiSession y runWorkflowWithUi; dashboard-down-editor.ts importa openWorkflowDashboard
 * (reexportado desde acá) y los tipos Dashboard{CommandSubmitter,Opener}.
 */
import { existsSync } from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { notify } from "./notify.js";
import type { PiSessionModel } from "./pi-session.js";
import { sessionManagerMetadata } from "./pi-session.js";
import { activeRunCount } from "./run-registry.js";
import {
	clearWorkflowWidget,
	setWorkflowErrorStatus,
	setWorkflowFinishedStatus,
	setWorkflowRunningStatus,
	setWorkflowWidget,
} from "./run-status-ui.js";
import type {
	PreparedWorkflowRun,
	RunLimits,
	WorkflowDefinition,
	WorkflowLogEntry,
	WorkflowRunResult,
	WorkflowRunStatus,
} from "./types.js";
import { runWorkflow } from "./workflow-engine.js";

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

export type DashboardCommandSubmitter = (command: string) => void;
export type DashboardOpener = (submitCommand?: DashboardCommandSubmitter) => Promise<void>;

export interface WorkflowDashboardOpenOptions {
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
		notify(ctx, "No se puede cambiar: la sesión de Pi seleccionada no registró un archivo de sesión.", "warning");
		return;
	}
	const currentFile = sessionManagerMetadata(ctx).sessionFile;
	if (currentFile && path.resolve(currentFile) === path.resolve(sessionFile)) {
		notify(ctx, "Ya estás en la sesión de Pi seleccionada.", "info");
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
			"No se puede cambiar desde este contexto del dashboard. Abrilo desde el prompt con /workflow sessions.",
			"warning",
		);
		return;
	}
	if (!existsSync(sessionFile)) {
		notify(ctx, `No se puede cambiar: el archivo de sesión ya no existe: ${sessionFile}`, "warning");
		return;
	}
	const label = session.sessionName || session.sessionId || path.basename(sessionFile);
	const activeRuns = activeRunCount();
	if (activeRuns > 0)
		notify(
			ctx,
			`Cambiando de sesión de Pi; ${activeRuns} workflow run(s) activos en este Pi se cancelarán.`,
			"warning",
		);
	const result = await switchSession(sessionFile, {
		withSession: async (nextCtx) => {
			nextCtx.ui.notify?.(`Se cambió a la sesión de Pi: ${label}`, "info");
		},
	});
	if (result.cancelled) notify(ctx, "Cambio de sesión cancelado.", "warning");
}

export { openWorkflowDashboard } from "./dashboard-open.js";
