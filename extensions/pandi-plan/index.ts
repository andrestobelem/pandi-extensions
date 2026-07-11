/**
 * `/plan` de estilo Claude ("modo plan") para Pi (P0).
 *
 * Arquitectura modularizada al estilo pandi-loop:
 * - plan-bootstrap.ts — configurePlanGuard / Rehydrate / CommandHandler
 * - active-plans.ts — Map en memoria + status line
 * - session-hooks.ts — tool_call / session_start / shutdown
 * - plan-tools.ts — submit_plan + enter_plan_mode
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { refreshPlanStatus } from "./active-plans.js";
import { registerPlanCommand } from "./command-handler.js";
import { persist } from "./persistence.js";
import { configurePlanExtension } from "./plan-bootstrap.js";
import { currentPlan } from "./plan-guard.js";
import { registerPlanTools } from "./plan-tools.js";
import { registerPlanHooks } from "./session-hooks.js";
import { wake } from "./wake.js";

export {
	isPlanModeActive,
	PLAN_MODE_GUARD,
	PLAN_MODE_GUARD_SYMBOL,
	type PlanModeGuard,
} from "./plan-guard.js";
export type { PlanState, PlanStatus } from "./state.js";

export default function planExtension(pi: ExtensionAPI): void {
	configurePlanExtension();
	registerPlanTools(pi, {
		pi,
		currentPlan,
		persist,
		refreshPlanStatus,
		wake,
	});
	registerPlanCommand(pi);
	registerPlanHooks(pi);
}
