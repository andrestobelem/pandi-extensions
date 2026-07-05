/**
 * pi-ask — herramientas interactivas de decisión que el modelo puede invocar.
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

const ChoiceParams = Type.Object({
	question: Type.String({ description: "La pregunta o prompt que se muestra arriba de las opciones." }),
	options: Type.Array(Type.String(), {
		description: "Las opciones para elegir, en el orden de visualización (al menos una).",
	}),
});

const ConfirmParams = Type.Object({
	title: Type.String({ description: "La pregunta de sí/no, mostrada como título del diálogo." }),
	message: Type.Optional(Type.String({ description: "Línea secundaria opcional con más detalle." })),
});

const NO_UI_MESSAGE =
	"Error: la UI interactiva no está disponible (modo no interactivo). Preguntale al usuario en texto plano.";

function textResult(text: string, details: unknown) {
	return { content: [{ type: "text" as const, text }], details };
}

export default function askExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "ask_choice",
		label: "Ask choice",
		description:
			"Pedile al usuario que elija UNA opción de una lista mediante un selector TUI interactivo (flechas + Enter). " +
			"Usalo en un punto de decisión con varias opciones válidas, en vez de un menú numerado en texto plano. " +
			'Devuelve JSON {"index","label"} para la opción elegida (index es 1-based), o {"cancelled":true} si el usuario cancela.',
		parameters: ChoiceParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const options = Array.isArray(params.options) ? params.options : [];
			if (!ctx.hasUI) {
				return textResult(NO_UI_MESSAGE, { cancelled: true, reason: "no-ui" });
			}
			if (options.length === 0) {
				return textResult("Error: no se proporcionaron opciones — pasale al menos una opción a ask_choice.", {
					cancelled: true,
					reason: "no-options",
				});
			}
			const choice = await ctx.ui.select(params.question, options);
			if (choice == null) {
				return textResult(JSON.stringify({ cancelled: true }), {
					cancelled: true,
					question: params.question,
					options,
				});
			}
			const index = options.indexOf(choice) + 1;
			return textResult(JSON.stringify({ index, label: choice }), {
				cancelled: false,
				index,
				label: choice,
				question: params.question,
				options,
			});
		},
	});

	pi.registerTool({
		name: "ask_confirm",
		label: "Ask confirm",
		description:
			"Hacele al usuario una pregunta de sí/no mediante un diálogo de confirmación TUI interactivo. " +
			'Devuelve JSON {"confirmed":true|false} (false también en cancelación/timeout).',
		parameters: ConfirmParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!ctx.hasUI) {
				return textResult(NO_UI_MESSAGE, { confirmed: false, reason: "no-ui" });
			}
			const ok = await ctx.ui.confirm(params.title, params.message ?? "");
			return textResult(JSON.stringify({ confirmed: Boolean(ok) }), { confirmed: Boolean(ok), title: params.title });
		},
	});
}
