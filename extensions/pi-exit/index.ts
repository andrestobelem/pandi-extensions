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
 * Arguments are ignored — exiting takes no parameters. ctx.shutdown() is deferred by the
 * host until the agent is idle, so it is safe to call from the command handler.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function exitExtension(pi: ExtensionAPI): void {
	pi.registerCommand("exit", {
		description: "Exit pi cleanly (Claude-style alias for /quit).",
		handler: async (_args, ctx) => {
			ctx.shutdown();
		},
	});
}
