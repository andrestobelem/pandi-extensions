/**
 * Notificación al usuario (duplicación intencional; ver pandi-effort/notify.ts).
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

export function reportClearFailure(ctx: ExtensionCommandContext, message: string): void {
	if (ctx.mode === "print") {
		console.error(message);
		return;
	}
	if (ctx.hasUI) {
		ctx.ui.notify(message, "error");
		return;
	}
	console.error(message);
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function formatClearFailure(error: unknown): string {
	return `/clear falló: ${errorMessage(error)} — probá /new en su lugar.`;
}
