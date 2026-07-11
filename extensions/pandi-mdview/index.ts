/**
 * pandi-mdview: comando `/mdview` y tool `view_markdown` para ver Markdown en TUI.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerMdviewCommand } from "./command-handler.js";
import { registerViewMarkdownTool } from "./tool-handler.js";

export { resolveMarkdownPath } from "./document.js";

export default function markdownViewExtension(pi: ExtensionAPI): void {
	registerMdviewCommand(pi);
	registerViewMarkdownTool(pi);
}
