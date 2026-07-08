import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "./parse.js";

const CANONICAL_EFFORT_OPTIONS: {
	value: ThinkingLevel | "ultracode" | "status";
	description: string;
	selectLabel?: string;
}[] = [
	{
		value: "off",
		description: "Desactivar el esfuerzo de pensamiento del modelo",
		selectLabel: "off — desactivar el pensamiento",
	},
	{ value: "minimal", description: "Esfuerzo mínimo", selectLabel: "minimal — esfuerzo mínimo" },
	{ value: "low", description: "Esfuerzo bajo", selectLabel: "low — esfuerzo bajo" },
	{ value: "medium", description: "Esfuerzo medio", selectLabel: "medium — esfuerzo medio" },
	{ value: "high", description: "Esfuerzo alto", selectLabel: "high — esfuerzo alto" },
	{ value: "xhigh", description: "Esfuerzo extra alto", selectLabel: "xhigh — esfuerzo extra alto" },
	{
		value: "ultracode",
		description: "Esfuerzo extra alto + router de dynamic_workflow",
		selectLabel: "ultracode — xhigh + router de dynamic_workflow",
	},
	{ value: "status", description: "Mostrar el esfuerzo actual" },
];

const ALIAS_COMPLETIONS: { value: string; description: string }[] = [
	{ value: "none", description: "Alias de off" },
	{ value: "max", description: "Alias de xhigh" },
	{ value: "ultra-code", description: "Alias de ultracode" },
];

const toCompletionItem = ({ value, description }: { value: string; description: string }) => ({
	value,
	label: value,
	description,
});

const COMPLETION_ITEMS: { value: string; label: string; description: string }[] = [
	...CANONICAL_EFFORT_OPTIONS.map(toCompletionItem),
	...ALIAS_COMPLETIONS.map(toCompletionItem),
];

const SELECT_ITEMS = CANONICAL_EFFORT_OPTIONS.flatMap((item) => (item.selectLabel ? [item.selectLabel] : []));

export function getEffortArgumentCompletions(prefix: string):
	| {
			value: string;
			label: string;
			description: string;
	  }[]
	| null {
	const normalizedPrefix = prefix.trim().toLowerCase();
	const items = COMPLETION_ITEMS.filter((item) => item.value.toLowerCase().startsWith(normalizedPrefix));
	return items.length > 0 ? items : null;
}

export async function resolveEffortCommandValue(args: string, ctx: ExtensionContext): Promise<string> {
	const trimmed = args.trim();
	if (trimmed || !ctx.hasUI) return trimmed;

	const choice = await ctx.ui.select("Seleccioná el esfuerzo de pensamiento", SELECT_ITEMS);
	return choice?.split(/\s+/)[0] ?? "status";
}
