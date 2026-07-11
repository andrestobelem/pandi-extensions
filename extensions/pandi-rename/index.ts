/**
 * Comando `/rename` estilo Claude para Pi.
 *
 * - derive-name.ts — slugify y resumen determinístico
 * - border-label.ts — composición de etiqueta en el borde
 * - name-border-editor.ts — capa TUI del editor
 * - command-handler.ts — `/rename`
 * - session-hooks.ts — borde al inicio + pista de salida
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { handleRenameCommand } from "./command-handler.js";
import { handleSessionStart, registerSessionInfoChanged, setSessionExitHintName } from "./session-hooks.js";

export default function renameExtension(pi: ExtensionAPI): void {
	pi.registerCommand("rename", {
		description:
			"Renombra la sesión actual con un slug. Sin argumento, resume tu actividad más reciente mediante el LLM.",
		handler: async (args, ctx) => await handleRenameCommand(pi, args, ctx, setSessionExitHintName),
	});

	pi.on("session_start", async (_event, ctx) => handleSessionStart(pi, ctx));
	registerSessionInfoChanged(pi);
}
