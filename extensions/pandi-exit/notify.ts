/**
 * Notificación al usuario (duplicación intencional; ver pandi-effort/notify.ts).
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

export function notify(
	ctx: ExtensionCommandContext,
	message: string,
	type: "info" | "warning" | "error" = "info",
): void {
	if (ctx.mode === "print") {
		(type === "info" ? console.log : console.error)(message);
		return;
	}
	if (ctx.hasUI) {
		ctx.ui.notify(message, type);
		return;
	}
	if (type !== "info") console.error(message);
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function formatExitFailure(error: unknown): string {
	return `no se pudo salir: ${errorMessage(error)} — probá /quit en su lugar`;
}
