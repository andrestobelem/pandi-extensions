/**
 * Status de run activo en la barra del host — idle vs N runs en background.
 * Vive en lifecycle para romper el ciclo lifecycle↔tui (registry + status key acá;
 * tui/status-ui conserva los setters de progreso/fin/error y reexporta refresh).
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { workflowDashboardHint } from "../lib/presentation.js";
import { activeRunCount } from "./registry.js";

/** Clave compartida con tui/status-ui para la línea de status del host. */
export const WORKFLOW_STATUS_KEY = "dynamic-workflows";

export function setWorkflowIdleStatus(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	ctx.ui.setStatus(WORKFLOW_STATUS_KEY, ctx.ui.theme.fg("dim", "wf · /workflows"));
}

export function refreshActiveWorkflowStatus(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	const count = activeRunCount();
	if (count === 0) {
		setWorkflowIdleStatus(ctx);
		return;
	}
	const theme = ctx.ui.theme;
	ctx.ui.setStatus(
		WORKFLOW_STATUS_KEY,
		`${theme.fg("accent", "▶ wf")} ${theme.fg("dim", `${count} bg ${workflowDashboardHint()}`)}`,
	);
}
