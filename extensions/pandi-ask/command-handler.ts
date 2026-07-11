/**
 * Slash command `/ask` — toggles de recomendado.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type AskRecommendationSettings, parseToggle, settingsText } from "./settings.js";

export function registerAskCommand(pi: ExtensionAPI, settings: AskRecommendationSettings): void {
	pi.registerCommand("ask", {
		description:
			"Configura los toggles de recomendado de pandi-ask: status | recommended on|off|status | recommended-timeout on|off|status.",
		handler: async (args, ctx) => handleAskCommand(settings, args, ctx),
	});
}

async function handleAskCommand(
	settings: AskRecommendationSettings,
	args: string,
	ctx: ExtensionContext,
): Promise<void> {
	const parts = String(args ?? "")
		.trim()
		.toLowerCase()
		.split(/\s+/)
		.filter(Boolean);
	const subject = parts[0] ?? "status";
	const action = parts[1] ?? "status";

	if (subject === "status") {
		ctx.ui.notify(settingsText(settings), "info");
		return;
	}

	if (subject !== "recommended" && subject !== "recommended-timeout") {
		ctx.ui.notify("Uso: /ask [status|recommended on|off|status|recommended-timeout on|off|status]", "warning");
		return;
	}

	if (action === "status") {
		ctx.ui.notify(settingsText(settings), "info");
		return;
	}

	const next = parseToggle(action);
	if (next === undefined) {
		ctx.ui.notify(`Uso: /ask ${subject} [on|off|status]`, "warning");
		return;
	}

	if (subject === "recommended") settings.chooseRecommended = next;
	else settings.timeoutRecommended = next;
	ctx.ui.notify(settingsText(settings), "info");
}
