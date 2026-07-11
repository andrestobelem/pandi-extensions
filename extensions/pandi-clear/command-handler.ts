import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { formatClearFailure, reportClearFailure } from "./notify.js";

export async function handleClearCommand(_args: string, ctx: ExtensionCommandContext): Promise<void> {
	try {
		await ctx.newSession();
	} catch (error) {
		reportClearFailure(ctx, formatClearFailure(error));
	}
}

export function registerClearCommand(pi: ExtensionAPI): void {
	pi.registerCommand("clear", {
		description: "Inicia una sesión nueva y limpia la conversación (alias al estilo Claude para /new).",
		handler: handleClearCommand,
	});
}
