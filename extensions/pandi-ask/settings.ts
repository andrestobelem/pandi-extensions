/**
 * Toggles de recomendado para /ask y helpers de configuración.
 */

export const RECOMMENDED_TIMEOUT_MS = 60_000;

export type AskRecommendationSettings = {
	chooseRecommended: boolean;
	timeoutRecommended: boolean;
};

const ON_VALUES = new Set(["on", "1", "true", "yes", "si", "sí"]);
const OFF_VALUES = new Set(["off", "0", "false", "no"]);

export function parseToggle(value: string | undefined): boolean | undefined {
	if (value === undefined) return undefined;
	const normalized = value.trim().toLowerCase();
	if (ON_VALUES.has(normalized)) return true;
	if (OFF_VALUES.has(normalized)) return false;
	return undefined;
}

export function settingsText(settings: AskRecommendationSettings): string {
	return `pandi-ask: recomendado inmediato: ${settings.chooseRecommended ? "on" : "off"}; recomendado diferido: ${settings.timeoutRecommended ? "on" : "off"} (${Math.round(RECOMMENDED_TIMEOUT_MS / 1000)}s)`;
}
