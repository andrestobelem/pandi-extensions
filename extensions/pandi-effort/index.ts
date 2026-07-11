/**
 * Comando `/effort` estilo Claude para Pi.
 *
 * - parse.ts / command-menu.ts — parsing y selector
 * - effort-status.ts — línea de estado
 * - effort-thinking.ts / effort-ultracode.ts — aplicar nivel y modo ultracode
 * - command-handler.ts — handler de `/effort`
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { handleEffortTarget } from "./command-handler.js";
import { getEffortArgumentCompletions, resolveEffortCommandValue } from "./command-menu.js";
import { parseEffortTarget } from "./parse.js";
import { handleSessionShutdown, handleSessionStart, handleThinkingLevelSelect } from "./session-hooks.js";

export default function effortExtension(pi: ExtensionAPI): void {
	pi.registerCommand("effort", {
		description: "Configurar el esfuerzo de pensamiento: off|minimal|low|medium|high|xhigh|ultracode",
		getArgumentCompletions: getEffortArgumentCompletions,
		handler: async (args, ctx) => {
			const value = await resolveEffortCommandValue(args, ctx);
			handleEffortTarget(pi, ctx, parseEffortTarget(value));
		},
	});

	pi.on("thinking_level_select", async (_event, ctx) => handleThinkingLevelSelect(pi, ctx));
	pi.on("session_start", async (_event, ctx) => handleSessionStart(pi, ctx));
	pi.on("session_shutdown", async (_event, ctx) => handleSessionShutdown(ctx));
}
