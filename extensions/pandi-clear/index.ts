/**
 * Claude-style `/clear` command for Pi.
 *
 * Claude Code's `/clear` clears the conversation and starts fresh. Pi already ships a
 * native `/new` that starts a new session, but no `/clear`. This extension adds `/clear`
 * as a thin alias so the Claude muscle-memory works in Pi (it coexists with `/new`, never
 * overrides it):
 *
 *   /clear   -> ctx.newSession()   (same fresh session as /new)
 *
 * Arguments are ignored. A cancelled new session (an extension vetoed it via
 * session_before_switch) is left silent — the host already handled the interaction.
 * A thrown newSession is reported, not propagated, so a failure never crashes the TUI.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

/** Notify the user, degrading gracefully outside the TUI (mirrors the sibling extensions). */
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
