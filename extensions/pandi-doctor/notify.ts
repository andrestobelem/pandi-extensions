import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export function notify(ctx: ExtensionContext, message: string, type: "info" | "warning" | "error" = "info"): void {
	if (ctx.mode === "print") {
		// stdout lleva la salida legible por máquinas en modo print; dejá advertencias/errores en stderr.
		(type === "info" ? console.log : console.error)(message);
		return;
	}
	if (ctx.hasUI) {
		ctx.ui.notify(message, type);
		return;
	}
	// Headless sin UI: mostrá los problemas en stderr en vez de descartarlos en silencio.
	if (type !== "info") console.error(message);
}
