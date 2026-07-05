/**
 * Presentación de línea de estado para la extensión `/plan`.
 *
 * Renderizado puro del estado de un plan único a la línea de estado de Pi, más el
 * resumen de estado textual usado por `/plan status`. Sin dueo del gate, sin selección
 * "qué plan está activo", sin I/O más allá de ctx.ui. La selección "qué plan está activo actualmente" se queda
 * en index.ts (refreshPlanStatus), que lee el mapa activePlans y llama estos
 * renderers.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PlanState } from "./index.js";

const PLAN_STATUS_KEY = "plan";

function planFlagSuffix(plan: PlanState): string {
	const tags: string[] = [];
	if (plan.nonInteractive) tags.push("plan-only");
	if (plan.ultracode) tags.push("uc");
	if (plan.ultracodeSteps) tags.push("uc-steps");
	return tags.length ? ` · ${tags.join(" · ")}` : "";
}

export function setPlanStatus(ctx: ExtensionContext, plan: PlanState): void {
	if (!ctx.hasUI) return;
	const theme = ctx.ui.theme;
	const subs = plan.submissions > 0 ? ` · ${plan.submissions} submitted` : "";
	const rej = plan.rejections > 0 ? `/${plan.rejections} rejected` : "";
	ctx.ui.setStatus(
		PLAN_STATUS_KEY,
		`${theme.fg("accent", "▣ plan")} ${theme.fg("dim", `read-only${subs}${rej}${planFlagSuffix(plan)}`)}`,
	);
}

export function clearPlanStatus(ctx: ExtensionContext): void {
	if (ctx.hasUI) ctx.ui.setStatus(PLAN_STATUS_KEY, undefined);
}

export function formatStatus(plan: PlanState): string {
	const gate = plan.active ? "activo (gate de solo lectura ARMADO)" : `inactivo [${plan.status}]`;
	const counts = ` — ${plan.submissions} plan(es) enviado(s), ${plan.rejections} rechazado(s)`;
	const tags = [
		plan.nonInteractive ? "plan-only" : undefined,
		plan.ultracode ? "ultracode" : undefined,
		plan.ultracodeSteps ? "ultracode-steps" : undefined,
	].filter(Boolean);
	const posture = tags.length ? ` [${tags.join(", ")}]` : "";
	return `Plan ${plan.planId}: ${gate}${posture}${counts}. Tarea: ${plan.task}`;
}
