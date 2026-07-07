/**
 * pandi-ask — herramientas interactivas de decisión que el modelo puede invocar.
 *
 * El asistente produce texto y tool calls; no puede abrir un selector TUI desde una
 * respuesta simple. Estas tools envuelven los helpers de diálogo de pi (`ctx.ui.select` / `ctx.ui.confirm`, que
 * funcionan tanto en modo TUI como RPC) para que el modelo pueda presentar un punto de decisión como un
 * selector interactivo y recuperar la elección, en vez de un menú numerado en texto plano.
 *
 * - `ask_choice(question, options)` → JSON `{ "index": <1-based>, "label": <option> }`,
 *   o `{ "cancelled": true }` si el usuario cancela.
 * - `ask_confirm(title, message?)` → JSON `{ "confirmed": true | false }` (false en
 *   cancelación/timeout).
 *
 * En modos no interactivos (sin `ctx.hasUI`), ninguna tool abre un diálogo y ambas devuelven un
 * error en texto plano para que quien llama vuelva a preguntar en texto.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { jsonResult, NO_UI_MESSAGE, textResult } from "./tool-results.js";

export const RECOMMENDED_TIMEOUT_MS = 60_000;

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

export { jsonResult, NO_UI_MESSAGE, textResult } from "./tool-results.js";

type AskRecommendationSettings = {
	chooseRecommended: boolean;
	timeoutRecommended: boolean;
};

type RecommendedChoice = {
	index: number;
	label: string;
};

type RecommendedMode = "recommended" | "recommended-timeout" | "recommended-timeout-no-ui";

const ON_VALUES = new Set(["on", "1", "true", "yes", "si", "sí"]);
const OFF_VALUES = new Set(["off", "0", "false", "no"]);

function parseToggle(value: string | undefined): boolean | undefined {
	if (value === undefined) return undefined;
	const normalized = value.trim().toLowerCase();
	if (ON_VALUES.has(normalized)) return true;
	if (OFF_VALUES.has(normalized)) return false;
	return undefined;
}

function settingsText(settings: AskRecommendationSettings): string {
	return `pandi-ask: recomendado inmediato: ${settings.chooseRecommended ? "on" : "off"}; recomendado diferido: ${settings.timeoutRecommended ? "on" : "off"} (${Math.round(RECOMMENDED_TIMEOUT_MS / 1000)}s)`;
}

function registerAskCommand(pi: ExtensionAPI, settings: AskRecommendationSettings) {
	pi.registerCommand("ask", {
		description:
			"Configura los toggles de recomendado de pandi-ask: status | recommended on|off|status | recommended-timeout on|off|status.",
		handler: async (args, ctx) => {
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
		},
	});
}

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

export default function askExtension(pi: ExtensionAPI) {
	const settings: AskRecommendationSettings = {
		chooseRecommended: false,
		timeoutRecommended: false,
	};
	registerAskCommand(pi, settings);
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
				return jsonResult(
					{ cancelled: true },
					{
						cancelled: true,
						question: params.question,
						options,
					},
				);
			}
			const index = options.indexOf(choice) + 1;
			return jsonResult(
				{ index, label: choice },
				{
					cancelled: false,
					index,
					label: choice,
					question: params.question,
					options,
				},
			);
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
