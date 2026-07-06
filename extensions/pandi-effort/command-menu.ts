import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "./parse.js";

const CANONICAL_EFFORT_OPTIONS: {
	value: ThinkingLevel | "ultracode" | "status";
	description: string;
	selectLabel?: string;
}[] = [
	{
		value: "off",
		description: "Desactivar el thinking/reasoning del modelo",
		selectLabel: "off — desactivar el thinking",
	},
	{ value: "minimal", description: "Thinking mínimo", selectLabel: "minimal — thinking mínimo" },
	{ value: "low", description: "Thinking bajo", selectLabel: "low — thinking bajo" },
	{ value: "medium", description: "Thinking medio", selectLabel: "medium — thinking medio" },
	{ value: "high", description: "Thinking alto", selectLabel: "high — thinking alto" },
	{ value: "xhigh", description: "Thinking extra alto", selectLabel: "xhigh — thinking extra alto" },
	{
		value: "ultracode",
		description: "Thinking extra alto + router de dynamic workflow",
		selectLabel: "ultracode — xhigh + router de dynamic workflow",
	},
	{ value: "status", description: "Mostrar el esfuerzo actual" },
];

const ALIAS_COMPLETIONS: { value: string; description: string }[] = [
	{ value: "none", description: "Alias de off" },
	{ value: "max", description: "Alias de xhigh" },
	{ value: "ultra-code", description: "Alias de ultracode" },
];

const COMPLETIONS: { value: string; description: string }[] = [
	...CANONICAL_EFFORT_OPTIONS.map(({ value, description }) => ({ value, description })),
	...ALIAS_COMPLETIONS,
];

const SELECT_ITEMS = CANONICAL_EFFORT_OPTIONS.flatMap((item) => (item.selectLabel ? [item.selectLabel] : []));

export function getEffortArgumentCompletions(prefix: string):
	| {
			value: string;
			label: string;
			description: string;
	  }[]
	| null {
	const needle = prefix.trim().toLowerCase();
	const items = COMPLETIONS.filter((item) => item.value.startsWith(needle));
	return items.length > 0
		? items.map((item) => ({
				value: item.value,
				label: item.value,
				description: item.description,
			}))
		: null;
}

export async function resolveEffortCommandValue(args: string, ctx: ExtensionContext): Promise<string> {
	const trimmed = args.trim();
	if (trimmed || !ctx.hasUI) return trimmed;

	const choice = await ctx.ui.select("Seleccioná el esfuerzo de pensamiento", SELECT_ITEMS);
	return choice?.split(/\s+/)[0] ?? "status";
}
