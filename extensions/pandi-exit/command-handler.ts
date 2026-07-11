import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { formatExitFailure, notify } from "./notify.js";

export async function handleExitCommand(_args: string, ctx: ExtensionCommandContext): Promise<void> {
	try {
		ctx.shutdown();
	} catch (error) {
		notify(ctx, formatExitFailure(error), "error");
	}
}

export function registerExitCommand(pi: ExtensionAPI): void {
	pi.registerCommand("exit", {
		description: "Sale de Pi de forma limpia (alias al estilo Claude de /quit).",
		handler: handleExitCommand,
	});
}
