/**
 * pandi-ask — herramientas interactivas de decisión que el modelo puede invocar.
 *
 * Arquitectura modularizada al estilo pandi-auto-compact:
 * - settings.ts — toggles de recomendado
 * - tools.ts — ask_choice / ask_confirm
 * - command-handler.ts — /ask
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAskCommand } from "./command-handler.js";
import { type AskRecommendationSettings, RECOMMENDED_TIMEOUT_MS } from "./settings.js";
import { registerAskTools } from "./tools.js";

export { jsonResult, NO_UI_MESSAGE, textResult } from "./tool-results.js";
export { RECOMMENDED_TIMEOUT_MS };

export default function askExtension(pi: ExtensionAPI) {
	const settings: AskRecommendationSettings = {
		chooseRecommended: false,
		timeoutRecommended: false,
	};
	registerAskCommand(pi, settings);
	registerAskTools(pi, settings);
}
