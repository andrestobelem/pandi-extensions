/**
 * Comando `/exit` estilo Claude para Pi.
 *
 * Claude Code usa `/exit` (y `/quit`) para salir de la sesión. Pi ya trae un `/quit`
 * nativo que cierra de forma limpia, pero no `/exit`. Esta extensión agrega `/exit` como
 * alias fino para que la memoria muscular de Claude funcione en Pi (coexiste con `/quit`,
 * nunca lo reemplaza):
 *
 *   /exit   -> ctx.shutdown()   (mismo cierre limpio que /quit)
 *
 * Los argumentos se ignoran: salir no recibe parámetros. ctx.shutdown() difiere el cierre
 * real hasta que el agente queda inactivo, pero delega en un shutdownHandler provisto por
 * el modo que PUEDE lanzar de forma síncrona; por eso se protege igual que pandi-clear
 * protege ctx.newSession(), informando la falla en vez de filtrar un error genérico de la
 * extensión.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

/** Notifica al usuario y degrada con gracia fuera de la TUI (refleja las extensiones hermanas). */
function notify(ctx: ExtensionCommandContext, message: string, type: "info" | "warning" | "error" = "info"): void {
	if (ctx.mode === "print") {
		if (type === "info") console.log(message);
		else console.error(message);
		return;
	}
	if (ctx.hasUI) {
		ctx.ui.notify(message, type);
		return;
	}
	if (type !== "info") console.error(message);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function formatExitFailure(error: unknown): string {
	return `no se pudo salir: ${errorMessage(error)} — probá /quit en su lugar`;
}

export default function exitExtension(pi: ExtensionAPI): void {
	pi.registerCommand("exit", {
		description: "Sale de pi de forma limpia (alias estilo Claude de /quit).",
		handler: async (_args, ctx) => {
			try {
				ctx.shutdown();
			} catch (error) {
				notify(ctx, formatExitFailure(error), "error");
			}
		},
	});
}
