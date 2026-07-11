/**
 * pandi-mdview: comando `/mdview` y tool `view_markdown` para ver Markdown en TUI.
 *
 * - document.ts — resolución de rutas y carga validada
 * - viewer-component.ts — visor con scroll (TUI)
 * - show-markdown.ts — comando slash
 * - tool-handler.ts — herramienta invocable por el modelo
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { showMarkdown } from "./show-markdown.js";
import { registerViewMarkdownTool } from "./tool-handler.js";

export { resolveMarkdownPath } from "./document.js";

export default function markdownViewExtension(pi: ExtensionAPI): void {
	pi.registerCommand("mdview", {
		description: "Ver un archivo Markdown en la TUI de Pi",
		handler: async (args, ctx) => {
			await showMarkdown(args, ctx);
		},
	});

	registerViewMarkdownTool(pi);
}
