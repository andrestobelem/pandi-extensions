export type NotifyType = "info" | "warning" | "error";

export interface NotifyContext {
	mode: string;
	hasUI: boolean;
	ui: { notify(message: string, type?: NotifyType): void };
}

export function notify(ctx: NotifyContext, message: string, type: NotifyType = "info"): void {
	if (ctx.mode === "print") {
		// stdout lleva la salida legible por máquinas en modo print; dejá warnings/errors en stderr.
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
