/**
 * Herramientas `ask_choice` y `ask_confirm`.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type AskRecommendationSettings, RECOMMENDED_TIMEOUT_MS } from "./settings.js";
import { jsonResult, NO_UI_MESSAGE, textResult } from "./tool-results.js";

const ChoiceParams = Type.Object({
	question: Type.String({ description: "La pregunta o prompt que se muestra arriba de las opciones." }),
	options: Type.Array(Type.String(), {
		description: "Las opciones para elegir, en el orden de visualización (al menos una).",
	}),
	recommendedIndex: Type.Optional(
		Type.Number({ description: "Opción recomendada como índice 1-based dentro de `options`." }),
	),
	recommendedLabel: Type.Optional(
		Type.String({ description: "Opción recomendada por texto exacto; se usa si no hay recommendedIndex válido." }),
	),
});

const ConfirmParams = Type.Object({
	title: Type.String({ description: "La pregunta de sí/no, mostrada como título del diálogo." }),
	message: Type.Optional(Type.String({ description: "Línea secundaria opcional con más detalle." })),
	recommended: Type.Optional(
		Type.Boolean({ description: "Respuesta recomendada cuando los toggles de recomendado están activos." }),
	),
});

type RecommendedChoice = {
	index: number;
	label: string;
};

type RecommendedMode = "recommended" | "recommended-timeout" | "recommended-timeout-no-ui";

function resolveRecommendedChoice(
	params: Record<string, unknown>,
	options: readonly string[],
): RecommendedChoice | undefined {
	const rawIndex = params.recommendedIndex;
	if (typeof rawIndex === "number" && Number.isInteger(rawIndex) && rawIndex >= 1 && rawIndex <= options.length) {
		return { index: rawIndex, label: options[rawIndex - 1] ?? "" };
	}

	const label = params.recommendedLabel;
	if (typeof label === "string") {
		const index = options.indexOf(label) + 1;
		if (index > 0) return { index, label };
	}

	return undefined;
}

function selectedChoiceResult(index: number, label: string, question: string, options: readonly string[]) {
	return jsonResult(
		{ index, label },
		{
			cancelled: false,
			index,
			label,
			question,
			options,
		},
	);
}

function cancelledChoiceResult(question: string, options: readonly string[]) {
	return jsonResult(
		{ cancelled: true },
		{
			cancelled: true,
			question,
			options,
		},
	);
}

function recommendedChoiceResult(
	recommended: RecommendedChoice,
	question: string,
	options: readonly string[],
	mode: RecommendedMode,
) {
	return jsonResult(
		{ index: recommended.index, label: recommended.label, recommended: true },
		{
			cancelled: false,
			index: recommended.index,
			label: recommended.label,
			question,
			options,
			recommended: true,
			mode,
		},
	);
}

function recommendedConfirmResult(confirmed: boolean, title: string, mode: RecommendedMode) {
	return jsonResult({ confirmed, recommended: true }, { confirmed, title, recommended: true, mode });
}

function hasRecommendedConfirm(
	params: Record<string, unknown>,
): params is Record<string, unknown> & { recommended: boolean } {
	return typeof params.recommended === "boolean";
}

function makeTimeoutDialogOptions(parentSignal: AbortSignal | undefined, timeoutMs: number) {
	const controller = new AbortController();
	let timedOut = false;
	let disposed = false;
	const onParentAbort = () => controller.abort();

	if (parentSignal?.aborted) controller.abort();
	else parentSignal?.addEventListener("abort", onParentAbort, { once: true });

	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, timeoutMs);

	return {
		options: { signal: controller.signal, timeout: timeoutMs },
		timedOut: () => timedOut,
		dispose: () => {
			if (disposed) return;
			disposed = true;
			clearTimeout(timer);
			parentSignal?.removeEventListener("abort", onParentAbort);
		},
	};
}

export function registerAskTools(pi: ExtensionAPI, settings: AskRecommendationSettings): void {
	registerChoiceTool(pi, settings);
	registerConfirmTool(pi, settings);
}

function registerChoiceTool(pi: ExtensionAPI, settings: AskRecommendationSettings) {
	pi.registerTool({
		name: "ask_choice",
		label: "Elegir opción",
		description:
			"Pedile al usuario que elija UNA opción de una lista mediante un selector TUI interactivo (flechas + Enter). " +
			"Usalo en un punto de decisión con varias opciones válidas, en vez de un menú numerado en texto plano. " +
			'Devuelve JSON {"index","label"} para la opción elegida (index es 1-based), o {"cancelled":true} si el usuario cancela. ' +
			"Si pasás recommendedIndex/recommendedLabel, los toggles de /ask pueden elegir esa opción recomendada.",
		parameters: ChoiceParams,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const options = Array.isArray(params.options) ? params.options : [];
			const recommended = resolveRecommendedChoice(params, options);

			if (recommended && settings.chooseRecommended) {
				return recommendedChoiceResult(recommended, params.question, options, "recommended");
			}

			if (!ctx.hasUI) {
				if (recommended && settings.timeoutRecommended) {
					return recommendedChoiceResult(recommended, params.question, options, "recommended-timeout-no-ui");
				}
				return textResult(NO_UI_MESSAGE, { cancelled: true, reason: "no-ui" });
			}
			if (options.length === 0) {
				return textResult("Error: no se proporcionaron opciones — pasale al menos una opción a ask_choice.", {
					cancelled: true,
					reason: "no-options",
				});
			}

			let choice: string | undefined;
			let timedOut = false;
			if (recommended && settings.timeoutRecommended) {
				const dialog = makeTimeoutDialogOptions(signal, RECOMMENDED_TIMEOUT_MS);
				try {
					choice = await ctx.ui.select(params.question, options, dialog.options);
					timedOut = dialog.timedOut();
				} finally {
					dialog.dispose();
				}
			} else {
				choice = await ctx.ui.select(params.question, options, signal ? { signal } : undefined);
			}

			if (choice == null) {
				if (recommended && timedOut) {
					return recommendedChoiceResult(recommended, params.question, options, "recommended-timeout");
				}
				return cancelledChoiceResult(params.question, options);
			}
			const index = options.indexOf(choice) + 1;
			return selectedChoiceResult(index, choice, params.question, options);
		},
	});
}

function registerConfirmTool(pi: ExtensionAPI, settings: AskRecommendationSettings) {
	pi.registerTool({
		name: "ask_confirm",
		label: "Confirmar",
		description:
			"Hacele al usuario una pregunta de sí/no mediante un diálogo de confirmación TUI interactivo. " +
			'Devuelve JSON {"confirmed":true|false} (false también en cancelación/timeout). ' +
			"Si pasás recommended, los toggles de /ask pueden elegir esa respuesta recomendada.",
		parameters: ConfirmParams,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (hasRecommendedConfirm(params) && settings.chooseRecommended) {
				return recommendedConfirmResult(params.recommended, params.title, "recommended");
			}

			if (!ctx.hasUI) {
				if (hasRecommendedConfirm(params) && settings.timeoutRecommended) {
					return recommendedConfirmResult(params.recommended, params.title, "recommended-timeout-no-ui");
				}
				return textResult(NO_UI_MESSAGE, { confirmed: false, reason: "no-ui" });
			}

			let ok: boolean;
			let timedOut = false;
			if (hasRecommendedConfirm(params) && settings.timeoutRecommended) {
				const dialog = makeTimeoutDialogOptions(signal, RECOMMENDED_TIMEOUT_MS);
				try {
					ok = await ctx.ui.confirm(params.title, params.message ?? "", dialog.options);
					timedOut = dialog.timedOut();
				} finally {
					dialog.dispose();
				}
				if (timedOut) return recommendedConfirmResult(params.recommended, params.title, "recommended-timeout");
			} else {
				ok = await ctx.ui.confirm(params.title, params.message ?? "", signal ? { signal } : undefined);
			}

			const confirmed = Boolean(ok);
			return jsonResult({ confirmed }, { confirmed, title: params.title });
		},
	});
}
