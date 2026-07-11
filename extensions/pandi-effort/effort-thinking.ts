import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { safeCurrentLevel, updateEffortStatus } from "./effort-status.js";
import { notify } from "./notify.js";
import type { ThinkingLevel } from "./parse.js";

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function formatSetEffortFailure(level: ThinkingLevel, error: unknown): string {
	return `No se pudo configurar el esfuerzo ${level}: ${errorMessage(error)}`;
}

export function setThinkingEffort(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	level: ThinkingLevel,
	options: { announce?: boolean } = {},
): ThinkingLevel | "unknown" {
	const before = safeCurrentLevel(pi);
	try {
		pi.setThinkingLevel(level);
	} catch (error) {
		notify(ctx, formatSetEffortFailure(level, error), "error");
		return before;
	}

	const actual = safeCurrentLevel(pi);
	updateEffortStatus(pi, ctx, actual);
	if (options.announce !== false) {
		if (actual === level) {
			notify(ctx, `Esfuerzo de pensamiento configurado en ${actual}.`, "info");
		} else {
			notify(
				ctx,
				`Se pidió el esfuerzo ${level}; el esfuerzo activo es ${actual} (el modelo actual puede limitar el pensamiento).`,
				"warning",
			);
		}
	}
	return actual;
}
