/**
 * `/plan` de estilo Claude ("modo plan") para Pi (P0).
 *
 * Arquitectura modularizada al estilo pandi-loop:
 * - active-plans.ts — Map en memoria + status line
 * - session-hooks.ts — session_start / shutdown
 * - plan-tools.ts — submit_plan + enter_plan_mode
 * - gate en gate.ts + tool-call-handler.ts; comandos en command-handler.ts
 *
 * Reglas duras: gate print/json; fork no migra plan-mode; allowlist solo lectura best-effort.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getActivePlans, refreshPlanStatus } from "./active-plans.js";
import { configureCommandHandler, handlePlanCommand } from "./command-handler.js";
import { persist } from "./persistence.js";
import { configurePlanGuard, currentPlan } from "./plan-guard.js";
import { PLAN_ARGUMENT_COMPLETIONS, registerPlanTools } from "./plan-tools.js";
import { configureRehydrate } from "./rehydrate.js";
import { handleSessionShutdown, handleSessionStart } from "./session-hooks.js";
import { handleToolCall } from "./tool-call-handler.js";
import { wake } from "./wake.js";

export {
	isPlanModeActive,
	PLAN_MODE_GUARD,
	PLAN_MODE_GUARD_SYMBOL,
	type PlanModeGuard,
} from "./plan-guard.js";
export type { PlanState, PlanStatus } from "./state.js";

export default function planExtension(pi: ExtensionAPI): void {
	configurePlanGuard({ getActivePlans });
	configureRehydrate({ getActivePlans, refreshPlanStatus });
	configureCommandHandler({ getActivePlans, refreshPlanStatus });

	registerPlanTools(pi, {
		pi,
		currentPlan,
		persist,
		refreshPlanStatus,
		wake,
	});

	pi.registerCommand("plan", {
		description:
			"Entrá en modo plan de solo lectura: /plan [--ultracode] [--ultracode-steps] [--auto-submit] <task> — investigá en solo lectura, escribí un plan, envialo para aprobación, y después implementá. /plan status | /plan dashboard | /plan exit | /plan cancel.",
		getArgumentCompletions: (argumentPrefix: string) => {
			const prefix = argumentPrefix.trim().toLowerCase();
			if (!prefix) return PLAN_ARGUMENT_COMPLETIONS;
			return PLAN_ARGUMENT_COMPLETIONS.filter((i) => i.value.toLowerCase().startsWith(prefix));
		},
		handler: async (args, ctx) => await handlePlanCommand(pi, args, ctx),
	});

	pi.on("tool_call", async (event, _ctx) => await handleToolCall(event));
	pi.on("session_start", async (event, ctx) => handleSessionStart(event, ctx));
	pi.on("session_shutdown", async (_event, ctx) => handleSessionShutdown(pi, ctx));
}
