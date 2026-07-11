import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { showMarkdown } from "./show-markdown.js";

export function registerMdviewCommand(pi: ExtensionAPI): void {
	pi.registerCommand("mdview", {
		description: "Ver un archivo Markdown en la TUI de Pi",
		handler: async (args, ctx) => {
			await showMarkdown(args, ctx);
		},
	});
}
