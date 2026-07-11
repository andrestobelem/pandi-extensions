/**
 * Manejo de `/plan` y ciclo de vida de armado/salida del modo plan.
 */

import * as crypto from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { parsePlanCommandIntent } from "./command-intent.js";
import { buildPlanDashboardMarkdown, renderPlanDashboardOverlay } from "./dashboard.js";
import {
	getSessionFlagDefault,
	parsePlanCommandFlags,
	resetSessionFlagDefaults,
	resolvePlanFlags,
	setSessionFlagDefault,
} from "./flags.js";
import { markPlanExited } from "./lifecycle.js";
import { notify } from "./notify.js";
import { PLAN_STATE_TYPE, persist } from "./persistence.js";
import { currentPlan, planModeActive } from "./plan-guard.js";
import type { PlanFlags } from "./posture.js";
import { makePlanningPrompt } from "./prompts.js";
import { findLastPlan, overlayRuntimePlans } from "./registry.js";
import { collectLatestByKey } from "./session-state.js";
import type { PlanState } from "./state.js";
import { formatStatus, setPlanStatus } from "./status.js";
import { canApproveInMode, wake } from "./wake.js";

export type CommandHandlerDeps = {
	getActivePlans: () => Map<string, PlanState>;
	refreshPlanStatus: (ctx: ExtensionContext) => void;
};

let commandDeps: CommandHandlerDeps | undefined;

export function configureCommandHandler(deps: CommandHandlerDeps): void {
	commandDeps = deps;
}

function requireCommandDeps(): CommandHandlerDeps {
	if (!commandDeps) throw new Error("command handler not configured");
	return commandDeps;
}

function collectAllPlans(ctx: ExtensionContext): PlanState[] {
	const activePlans = requireCommandDeps().getActivePlans();
	const latest = collectLatestByKey<PlanState>(ctx.sessionManager.getEntries(), PLAN_STATE_TYPE, (d) => d.planId);
	return overlayRuntimePlans(latest, activePlans.values());
}

async function openPlanDashboard(ctx: ExtensionContext): Promise<void> {
	const markdown = buildPlanDashboardMarkdown(collectAllPlans(ctx));
	if (ctx.mode !== "tui" || !ctx.hasUI) {
		console.log(markdown);
		return;
	}
	await renderPlanDashboardOverlay(ctx, markdown);
}

/**
 * Crea un plan fresco y ARMA el gate de solo lectura. Puro de cualquier decisión DELIVERY.
 */
export function createAndArmPlan(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	task: string,
	flags: Required<PlanFlags>,
): PlanState {
	const activePlans = requireCommandDeps().getActivePlans();
	const planId = crypto.randomBytes(4).toString("hex");
	const plan: PlanState = {
		planId,
		task,
		active: true,
		status: "planning",
		submissions: 0,
		rejections: 0,
		nonInteractive: flags.nonInteractive,
		ultracode: flags.ultracode,
		ultracodeSteps: flags.ultracodeSteps,
		autoSubmit: flags.nonInteractive ? false : flags.autoSubmit,
		startedAt: Date.now(),
		updatedAt: new Date().toISOString(),
	};
	activePlans.set(planId, plan);
	persist(pi, plan);
	setPlanStatus(ctx, plan);
	return plan;
}

export function startPlan(pi: ExtensionAPI, ctx: ExtensionContext, task: string): PlanState | undefined {
	const { task: cleanedTask, flags: commandFlags } = parsePlanCommandFlags(task);
	const flags = resolvePlanFlags({ ...commandFlags, nonInteractive: false });
	if (!canApproveInMode(ctx)) {
		notify(
			ctx,
			"/plan requiere una sesión TUI o RPC (este modo no puede ejecutar el protocolo de aprobación).",
			"error",
		);
		return undefined;
	}
	const trimmed = cleanedTask.trim();
	if (!trimmed) {
		notify(ctx, "Uso: /plan [--ultracode] [--ultracode-steps] <task>", "warning");
		return undefined;
	}
	if (planModeActive()) {
		notify(ctx, "El modo plan ya está activo. Usá /plan status, o /plan exit para salir.", "warning");
		return currentPlan();
	}

	const plan = createAndArmPlan(pi, ctx, trimmed, flags);
	wake(pi, ctx, makePlanningPrompt(plan));
	notify(
		ctx,
		`Entraste en modo plan (${plan.planId}). Solo lectura hasta que apruebes un plan. Tarea: ${trimmed}`,
		"info",
	);
	return plan;
}

export function exitPlan(pi: ExtensionAPI, ctx: ExtensionContext, reason: string): boolean {
	const plan = currentPlan();
	if (!plan) return false;
	markPlanExited(plan);
	persist(pi, plan);
	requireCommandDeps().refreshPlanStatus(ctx);
	notify(ctx, `Saliste del modo plan (${plan.planId}): ${reason}. No se inició ninguna implementación.`, "info");
	return true;
}

export async function handlePlanCommand(pi: ExtensionAPI, args: string, ctx: ExtensionContext): Promise<void> {
	const activePlans = requireCommandDeps().getActivePlans();
	const intent = parsePlanCommandIntent(args);

	if (intent.kind === "status") {
		const plan = currentPlan() ?? findLastPlan(activePlans.values());
		notify(ctx, plan ? formatStatus(plan) : "El modo plan no está activo.", "info");
		return;
	}
	if (intent.kind === "dashboard") {
		await openPlanDashboard(ctx);
		return;
	}
	if (intent.kind === "invalid-toggle") {
		notify(ctx, `Uso: /plan ${intent.label} [on|off|status]`, "warning");
		return;
	}
	if (intent.kind === "toggle") {
		if (intent.action === "on") setSessionFlagDefault(intent.key, true);
		else if (intent.action === "off") setSessionFlagDefault(intent.key, false);
		const current = getSessionFlagDefault(intent.key);
		const state = current === undefined ? "sin definir (lo decide env/param)" : current ? "on" : "off";
		notify(ctx, `/plan ${intent.label} valor por defecto de sesión: ${state}.`, "info");
		return;
	}
	if (intent.kind === "exit") {
		if (!exitPlan(pi, ctx, intent.reason)) {
			notify(ctx, "El modo plan no está activo; no hay nada de qué salir.", "warning");
		}
		return;
	}

	startPlan(pi, ctx, intent.task);
}

/** Limpia defaults de flags de sesión al inicio de una nueva sesión. */
export function resetPlanSessionDefaults(): void {
	resetSessionFlagDefaults();
}
