/**
 * `/improve-prompt` — reescribe un borrador y ofrece enviarlo tras confirmación.
 *
 * - build-improve-context.ts — prompt de reescritura
 * - answer-overlay.ts — revisión en TUI
 * - command-handler.ts — handler de `/improve-prompt`
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { handleImprovePromptCommand } from "./command-handler.js";

export default function improvePromptExtension(pi: ExtensionAPI): void {
	pi.registerCommand("improve-prompt", {
		description: "Reescribe un borrador de prompt y te ofrece enviarlo como tu próximo mensaje.",
		handler: async (args, ctx) => await handleImprovePromptCommand(args, ctx, pi),
	});
}
