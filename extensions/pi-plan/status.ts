/**
 * Status-line presentation for the `/plan` extension.
 *
 * Pure rendering of a single plan's status into Pi's status line, plus the textual
 * status summary used by `/plan status`. No gate ownership, no "which plan is active"
 * selection, no I/O beyond ctx.ui. The "which plan is currently active" selection stays
 * in index.ts (refreshPlanStatus), which reads the activePlans map and calls these
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
	const gate = plan.active ? "active (read-only gate ARMED)" : `inactive [${plan.status}]`;
	const counts = ` — ${plan.submissions} plan(s) submitted, ${plan.rejections} rejected`;
	const tags = [
		plan.nonInteractive ? "plan-only" : undefined,
		plan.ultracode ? "ultracode" : undefined,
		plan.ultracodeSteps ? "ultracode-steps" : undefined,
	].filter(Boolean);
	const posture = tags.length ? ` [${tags.join(", ")}]` : "";
	return `Plan ${plan.planId}: ${gate}${posture}${counts}. Task: ${plan.task}`;
}
