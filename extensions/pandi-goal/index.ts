/**
 * `/goal` estilo Claude para Pi (P0): un agente dirigido por objetivos.
 *
 * Arquitectura modularizada al estilo pandi-loop:
 * - goal-tools.ts — tool `goal_progress`
 * - command-handler.ts — `/goal`
 * - session-hooks.ts — session_start / shutdown / agent_end
 * - engine.ts / lifecycle.ts / progress-handler.ts — motor y máquina de estados
 *
 * AUTÓNOMO: este paquete no importa desde extensions/pandi-loop; los patrones están copiados.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildGoalArgumentCompletions, handleGoalCommand } from "./command-handler.js";
import { activeGoals } from "./engine.js";
import { registerGoalProgressTool } from "./goal-tools.js";
import { registerGoalSessionHooks } from "./session-hooks.js";

export default function goalExtension(pi: ExtensionAPI): void {
	registerGoalProgressTool(pi);

	pi.registerCommand("goal", {
		description:
			"Perseguí un objetivo hasta que quede verificado como terminado: /goal [--ultracode] <objective> [-- <criteria>] | /goal stop [id] | /goal status [id]",
		getArgumentCompletions: (argumentPrefix: string) =>
			buildGoalArgumentCompletions(activeGoals.values(), argumentPrefix),
		handler: async (args, ctx) => await handleGoalCommand(pi, args, ctx),
	});

	registerGoalSessionHooks(pi);
}
