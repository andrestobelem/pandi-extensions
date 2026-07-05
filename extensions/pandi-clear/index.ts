/**
 * Comando `/clear` estilo Claude para Pi.
 *
 * El `/clear` de Claude Code limpia la conversación y empieza de cero. Pi ya trae un
 * `/new` nativo que inicia una sesión nueva, pero no `/clear`. Esta extensión agrega
 * `/clear` como alias fino para que la memoria muscular de Claude funcione en Pi
 * (convive con `/new`; nunca lo sobrescribe):
 *
 *   /clear   -> ctx.newSession()   (misma sesión nueva que /new)
 *
 * Los argumentos se ignoran. Una sesión nueva cancelada (una extensión la vetó vía
 * session_before_switch) queda en silencio: el host ya manejó la interacción. Si
 * newSession lanza, se informa pero no se propaga, así una falla nunca rompe la TUI.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

/** Notifica al usuario y degrada con gracia fuera de la TUI (igual que las extensiones hermanas). */
function notify(ctx: ExtensionCommandContext, message: string, type: "info" | "warning" | "error" = "info"): void {
	if (ctx.mode === "print") {
		if (type === "info") console.log(message);
		else console.error(message);
		return;
	}
	if (ctx.hasUI) ctx.ui.notify(message, type);
}

export default function clearExtension(pi: ExtensionAPI): void {
	pi.registerCommand("clear", {
		description: "Iniciá una sesión nueva, limpiando la conversación (alias estilo Claude para /new).",
		handler: async (_args, ctx) => {
			try {
				await ctx.newSession();
			} catch (error) {
				notify(
					ctx,
					`clear falló: ${error instanceof Error ? error.message : String(error)} — probá /new en su lugar.`,
					"error",
				);
			}
		},
	});
}
