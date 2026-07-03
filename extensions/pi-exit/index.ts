/**
 * Claude-style `/exit` command for Pi.
 *
 * Claude Code uses `/exit` (and `/quit`) to leave the session. Pi already ships a native
 * `/quit` that shuts down cleanly, but no `/exit`. This extension adds `/exit` as a thin
 * alias so the Claude muscle-memory works in Pi (it coexists with `/quit`, never
 * overrides it):
 *
 *   /exit   -> ctx.shutdown()   (same clean shutdown as /quit)
 *
 * Arguments are ignored — exiting takes no parameters. ctx.shutdown() defers the actual
 * shutdown until the agent is idle, but it delegates to a mode-provided shutdownHandler
 * that CAN throw synchronously — so it is guarded like pi-clear guards ctx.newSession(),
 * reporting the failure instead of leaking a generic extension error.
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

export default function exitExtension(pi: ExtensionAPI): void {
	pi.registerCommand("exit", {
		description: "Exit pi cleanly (Claude-style alias for /quit).",
		handler: async (_args, ctx) => {
			try {
				ctx.shutdown();
			} catch (error) {
				notify(ctx, `exit failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});
}
