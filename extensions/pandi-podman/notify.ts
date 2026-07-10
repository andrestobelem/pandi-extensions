export type NotifyType = "info" | "warning" | "error";

export interface NotifyContext {
	mode: string;
	hasUI: boolean;
	ui: { notify(message: string, type?: NotifyType): void };
}

/** Conserva salida útil tanto en TUI como en los modos print/headless de Pi. */
export function notify(ctx: NotifyContext, message: string, type: NotifyType = "info"): void {
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
