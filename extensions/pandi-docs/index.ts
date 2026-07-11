/**
 * pandi-docs — convierte Markdown en un artifact HTML autocontenido con estilo según el
 * manual pandi-artifact-style (layout Claude-design × paleta Panda Syntax).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { tokenizeArgs } from "./args.js";
import { registerDocsCommand } from "./command-handler.js";
import { type ConvertResult, convertMarkdownFile } from "./convert.js";
import { registerMarkdownToHtmlTool } from "./tool-handler.js";

export { type ConvertResult, convertMarkdownFile, tokenizeArgs };

export default function docsExtension(pi: ExtensionAPI): void {
	registerDocsCommand(pi);
	registerMarkdownToHtmlTool(pi);
}
