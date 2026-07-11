/**
 * Comando `/mdview` y fallback sin TUI.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadMarkdownDocument } from "./document.js";
import { openMarkdownViewer } from "./viewer-component.js";

function notify(ctx: ExtensionContext, message: string, type: "info" | "warning" | "error" = "info"): void {
	if (ctx.mode === "print") {
		if (type === "info") console.log(message);
		else console.error(message);
		return;
	}
	if (ctx.hasUI) {
		ctx.ui.notify(message, type);
		return;
	}
	if (type !== "info") console.error(message);
}

export async function showMarkdown(pathArg: string, ctx: ExtensionContext): Promise<void> {
	const load = await loadMarkdownDocument(pathArg, ctx.cwd);
	if (!load.ok) {
		notify(ctx, load.message, load.level);
		return;
	}

	if (ctx.mode !== "tui") {
		console.log(load.content);
		return;
	}

	await openMarkdownViewer(ctx, load.filePath, load.content);
}
