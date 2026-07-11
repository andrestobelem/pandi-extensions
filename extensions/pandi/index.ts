/**
 * Pandi 🐼 — personaje panda para pi (splash, indicador animado, persona).
 *
 * - splash.ts / indicator-frames.ts — arte y animación del indicador
 * - pandi-ui.ts — header, status y working indicator
 * - command-handler.ts — `/pandi`
 * - session-hooks.ts — saludo, persona y verbos por turno
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { handlePandiCommand } from "./command-handler.js";
import { PANDI_SELECT_ITEMS, resolvePandiInput } from "./command-input.js";
import { pandaFrames } from "./indicator-frames.js";
import { createPandiRuntime } from "./pandi-runtime.js";
import { handleBeforeAgentStart, handleSessionStart, handleTurnEnd, handleTurnStart } from "./session-hooks.js";

export { PANDI_SELECT_ITEMS, pandaFrames, resolvePandiInput };

export default function pandiExtension(pi: ExtensionAPI): void {
	const runtime = createPandiRuntime();

	pi.on("session_start", async (_event, ctx) => handleSessionStart(ctx, runtime));
	pi.on("before_agent_start", async (event) => handleBeforeAgentStart(event, runtime));
	pi.on("turn_start", async (_event, ctx) => handleTurnStart(ctx, runtime));
	pi.on("turn_end", async (_event, ctx) => handleTurnEnd(ctx, runtime));

	pi.registerCommand("pandi", {
		description: "Pandi 🐼 — sin args abre el menú / status / art / face / on / off",
		handler: async (args, ctx) => await handlePandiCommand(args, ctx, runtime),
	});
}
