/**
 * Tipos y utilidades compartidas del slash command `/bg`.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { findJobDir } from "./job-listing.js";
import { validJobId } from "./storage.js";

const PLAN_MODE_GUARD_SYMBOL = Symbol.for("pandi-plan.plan-mode.guard");

interface PlanModeGuard {
	isActive(): boolean;
}

export interface BgResponse {
	message: string;
	details?: unknown;
	type?: "info" | "warning" | "error";
}

export const BG_ARGUMENT_COMPLETIONS = [
	{ value: "preview", description: "Dry-run (vista previa) de un comando en segundo plano" },
	{ value: "start", description: "Iniciar un job en segundo plano" },
	{ value: "cancel", description: "Cancelar un job activo en segundo plano" },
	{ value: "list", description: "Listar artifacts de jobs en segundo plano" },
	{ value: "status", description: "Leer el estado del job" },
	{ value: "logs", description: "Leer logs acotados del job" },
	{ value: "events", description: "Leer eventos acotados del ciclo de vida del job" },
	{ value: "delete", description: "Eliminar los artifacts de un job terminado" },
	{ value: "prune", description: "Vista previa/prune de artifacts de jobs terminados (--yes para eliminar)" },
].map((item) => ({ ...item, label: item.value }));

export function response(message: string, details?: unknown, type: BgResponse["type"] = "info"): BgResponse {
	return { message, details, type };
}

export function notifyBg(ctx: ExtensionContext, result: BgResponse): void {
	const type = result.type ?? "info";
	if (ctx.mode === "print") {
		(type === "info" ? console.log : console.error)(result.message);
		return;
	}
	if (ctx.hasUI) {
		ctx.ui.notify(result.message, type);
		return;
	}
	if (type !== "info") console.error(result.message);
}

function planModeActive(): boolean {
	const guard = (globalThis as Record<symbol, PlanModeGuard | undefined>)[PLAN_MODE_GUARD_SYMBOL];
	try {
		return guard?.isActive() === true;
	} catch {
		return false;
	}
}

export function rejectInPlanMode(action: "start" | "cancel" | "delete" | "prune"): BgResponse | undefined {
	if (!planModeActive()) return undefined;
	return response(
		`No se puede ejecutar /bg ${action} mientras el modo plan está activo. Aprobá o salí de /plan primero.`,
		{ action, blockedBy: "plan-mode" },
		"warning",
	);
}

export function canRunInMode(ctx: ExtensionContext): boolean {
	return ctx.mode === "tui" || ctx.mode === "rpc";
}

export async function resolveRunDir(ctx: ExtensionContext, jobId: string, usage: string): Promise<string | BgResponse> {
	if (!jobId || !validJobId(jobId)) return response(usage, undefined, "warning");
	const runDir = await findJobDir(ctx, jobId);
	if (!runDir) return response(`Job en segundo plano no encontrado: ${jobId}`, { jobId, found: false }, "warning");
	return runDir;
}
