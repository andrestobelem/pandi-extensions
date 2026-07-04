import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export function notify(ctx: ExtensionContext, message: string, type: "info" | "warning" | "error" = "info"): void {
	if (ctx.mode === "print") {
		// stdout carries machine-readable output in print mode; keep warnings/errors on stderr.
		(type === "info" ? console.log : console.error)(message);
		return;
	}
	if (ctx.hasUI) {
		ctx.ui.notify(message, type);
		return;
	}
	// Headless without UI: surface problems on stderr instead of silently dropping them.
	if (type !== "info") console.error(message);
}
