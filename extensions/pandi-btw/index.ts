/**
 * Comando `/btw` al estilo Claude para Pi.
 *
 * - build-btw-context.ts — contexto de una sola llamada
 * - answer-overlay.ts — overlay TUI
 * - command-handler.ts — handler de `/btw`
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { handleBtwCommand } from "./command-handler.js";

export default function btwExtension(pi: ExtensionAPI): void {
	pi.registerCommand("btw", {
		description:
			"Hacé una pregunta lateral rápida sobre la conversación actual (sin tools, no se agrega al historial).",
		handler: async (args, ctx) => await handleBtwCommand(args, ctx, pi),
	});
}
