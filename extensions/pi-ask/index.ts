/**
 * pi-ask — interactive decision tools the model can call.
 *
 * The assistant produces text and tool calls; it cannot pop a TUI selector from a plain
 * reply. These tools wrap pi's dialog helpers (`ctx.ui.select` / `ctx.ui.confirm`, which
 * work in both TUI and RPC modes) so the model can present a decision point as an
 * interactive picker and read back the choice — instead of a plain-text numbered menu.
 *
 * - `ask_choice(question, options)` → JSON `{ "index": <1-based>, "label": <option> }`,
 *   or `{ "cancelled": true }` if the user cancels.
 * - `ask_confirm(title, message?)` → JSON `{ "confirmed": true | false }` (false on
 *   cancel/timeout).
 *
 * In non-interactive modes (no `ctx.hasUI`) both tools open no dialog and return a
 * plain-text error so the caller falls back to asking in text.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const ChoiceParams = Type.Object({
	question: Type.String({ description: "The question or prompt shown above the options." }),
	options: Type.Array(Type.String(), {
		description: "The options to choose from, in display order (at least one).",
	}),
});

const ConfirmParams = Type.Object({
	title: Type.String({ description: "The yes/no question, shown as the dialog title." }),
	message: Type.Optional(Type.String({ description: "Optional secondary line with more detail." })),
});

const NO_UI_MESSAGE = "Error: interactive UI not available (non-interactive mode). Ask the user in plain text instead.";

function textResult(text: string, details: unknown) {
	return { content: [{ type: "text" as const, text }], details };
}

export default function askExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "ask_choice",
		label: "Ask choice",
		description:
			"Ask the user to pick ONE option from a list via an interactive TUI selector (arrow keys + Enter). " +
			"Use at a decision point with multiple valid options instead of a plain-text numbered menu. " +
			'Returns JSON {"index","label"} for the chosen option (index is 1-based), or {"cancelled":true} if the user cancels.',
		parameters: ChoiceParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const options = Array.isArray(params.options) ? params.options : [];
			if (!ctx.hasUI) {
				return textResult(NO_UI_MESSAGE, { cancelled: true, reason: "no-ui" });
			}
			if (options.length === 0) {
				return textResult("Error: no options provided.", { cancelled: true, reason: "no-options" });
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
			"Ask the user a yes/no question via an interactive TUI confirm dialog. " +
			'Returns JSON {"confirmed":true|false} (false also on cancel/timeout).',
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
