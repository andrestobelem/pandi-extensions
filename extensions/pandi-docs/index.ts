/**
 * pandi-docs — convierte Markdown en un artifact HTML autocontenido con estilo según el
 * manual pandi-artifact-style (layout Claude-design × paleta Panda Syntax).
 *
 * - convert.ts — conversión Markdown → HTML en disco
 * - command-handler.ts — `/docs`
 * - tool-handler.ts — `markdown_to_html`
 *
 * Los tokens pandi se leen al invocar desde el skill vendoreado en skills/pandi-artifact-style/.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { tokenizeArgs } from "./args.js";
import { handleDocsCommand } from "./command-handler.js";
import { type ConvertResult, convertMarkdownFile } from "./convert.js";
import { registerMarkdownToHtmlTool } from "./tool-handler.js";

export { type ConvertResult, convertMarkdownFile, tokenizeArgs };

export default function docsExtension(pi: ExtensionAPI): void {
	pi.registerCommand("docs", {
		description: "Convertí un archivo Markdown a HTML autocontenido con estilo pandi",
		handler: async (args, ctx) => await handleDocsCommand(args, ctx),
	});

	registerMarkdownToHtmlTool(pi);
}
