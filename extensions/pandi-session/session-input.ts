import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { PANDI_SESSION_SELECT_ITEMS, selectedPandiSessionActionValue } from "./session-actions.js";

export async function resolvePandiSessionInput(
	input: string,
	ctx: ExtensionCommandContext,
): Promise<string | undefined> {
	const trimmed = input.trim();
	if (trimmed || !ctx.hasUI || typeof ctx.ui?.select !== "function") return trimmed;
	const choice = await ctx.ui.select("Sesiones Pandi", PANDI_SESSION_SELECT_ITEMS);
	return selectedPandiSessionActionValue(choice);
}
