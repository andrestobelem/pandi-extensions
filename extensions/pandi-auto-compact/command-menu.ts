import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CODEX_DEFAULT_THRESHOLD_PERCENT, DEFAULT_THRESHOLD_PERCENT } from "./settings.js";

type CommandAction = {
	value: string;
	menuDescription?: string;
	completion?: true;
	completionDescription?: string;
};

type ToggleCommandAction = Omit<CommandAction, "value">;
type ToggleCommandGroup = {
	value: string;
	completionDescription: string;
	on: ToggleCommandAction;
	off: ToggleCommandAction;
};

function toggleCommandActions(
	value: string,
	completionDescription: string,
	on: ToggleCommandAction,
	off: ToggleCommandAction,
): readonly [CommandAction, CommandAction, CommandAction] {
	return [
		{ value, completionDescription },
		{ value: `${value} on`, ...on },
		{ value: `${value} off`, ...off },
	];
}

const TOGGLE_COMMAND_GROUPS = {
	bar: {
		value: "bar",
		completionDescription: "Alternar la barra de progreso del footer",
		on: { menuDescription: "mostrar la barra de progreso del footer", completion: true },
		off: { menuDescription: "ocultar la barra de progreso del footer", completion: true },
	},
	snapshot: {
		value: "snapshot",
		completionDescription: "Alternar las instantáneas recuperables de compactación",
		on: { menuDescription: "mantener instantáneas recuperables antes de compactar", completion: true },
		off: { menuDescription: "dejar de guardar instantáneas", completion: true },
	},
	summary: {
		value: "summary",
		completionDescription: "Alternar el resumen rápido/acotado de compactación",
		on: { menuDescription: "usar resumen rápido y acotado durante la compactación", completion: true },
		off: { menuDescription: "usar el resumen nativo de Pi", completion: true },
	},
	"clear-tools": {
		value: "clear-tools",
		completionDescription: "Alternar la elisión de salidas de tools viejas y grandes",
		on: {
			menuDescription: "elidir salidas de tools viejas y grandes (más barato que compactar)",
			completionDescription: "Elidir salidas de tools viejas y grandes en cada llamada al LLM",
		},
		off: { menuDescription: "dejar de elidir salidas de tools viejas", completion: true },
	},
} as const satisfies Record<string, ToggleCommandGroup>;

function toggleCommandGroup(name: keyof typeof TOGGLE_COMMAND_GROUPS) {
	const group = TOGGLE_COMMAND_GROUPS[name];
	return toggleCommandActions(group.value, group.completionDescription, group.on, group.off);
}

const COMMAND_ACTIONS: readonly CommandAction[] = [
	{ value: "run", menuDescription: "compactar el contexto ahora", completion: true },
	{ value: "status", menuDescription: "mostrar la configuración actual", completion: true },
	{ value: "on", menuDescription: "activar la auto-compactación", completion: true },
	{ value: "off", menuDescription: "desactivar la auto-compactación", completion: true },
	...toggleCommandGroup("bar"),
	...toggleCommandGroup("snapshot"),
	{
		value: "snapshots",
		menuDescription: "listar las instantáneas recientes",
		completionDescription: "Listar las instantáneas recientes de esta sesión",
	},
	...toggleCommandGroup("summary"),
	...toggleCommandGroup("clear-tools"),
	{ value: "threshold", menuDescription: "configurar el % de umbral de compactación" },
] as const;

function capitalizeFirst(text: string): string {
	return text.charAt(0).toUpperCase() + text.slice(1);
}

function describeActionCompletion(action: CommandAction): string | undefined {
	if (action.completionDescription) return action.completionDescription;
	if (action.completion && action.menuDescription) return capitalizeFirst(action.menuDescription);
	return undefined;
}

// Menú interactivo que se muestra para un `/auto-compact` sin argumentos en una sesión con UI. El texto
// ANTES de " — " es el comando canónico que el manejador ya entiende.
export const MENU_OPTIONS = COMMAND_ACTIONS.flatMap(({ value, menuDescription }) =>
	menuDescription ? [`${value} — ${menuDescription}`] : [],
);

// Valores predefinidos de threshold ofrecidos después de elegir "threshold"; se derivan para que el
// predeterminado actual siempre esté presente (y marcado abajo). La última entrada abre un campo de texto.
const THRESHOLD_PRESETS = [
	...new Set([20, 30, 40, 50, 60, 70, 80, DEFAULT_THRESHOLD_PERCENT, CODEX_DEFAULT_THRESHOLD_PERCENT]),
].sort((a, b) => a - b);
export const THRESHOLD_OPTIONS = [...THRESHOLD_PRESETS.map(String), "personalizado\u2026"];

function describeThresholdPreset(percent: number): string {
	if (percent === DEFAULT_THRESHOLD_PERCENT) return `Configurar el umbral al ${percent}% (predeterminado)`;
	if (percent === CODEX_DEFAULT_THRESHOLD_PERCENT)
		return `Configurar el umbral al ${percent}% (predeterminado de Codex)`;
	return `Configurar el umbral al ${percent}%`;
}

const ACTION_COMPLETIONS = COMMAND_ACTIONS.flatMap((action) => {
	const description = describeActionCompletion(action);
	return description ? [{ value: action.value, label: action.value, description }] : [];
});

// Items de autocompletado de argumentos. `value` se inserta en el editor al aceptar.
export const ARG_COMPLETIONS: { value: string; label: string; description: string }[] = [
	...ACTION_COMPLETIONS,
	...THRESHOLD_PRESETS.map((p) => ({
		value: String(p),
		label: `${p}%`,
		description: describeThresholdPreset(p),
	})),
];

// Cuando se invoca sin argumentos en una sesión con UI, abre un menú para elegir una configuración (y un segundo
// menú/input para el valor de threshold); si no, devuelve los args escritos sin cambios.
// Devuelve un texto que el manejador del comando ya entiende.
export async function resolveCommandValue(args: string, ctx: ExtensionContext): Promise<string> {
	const trimmed = args.trim();
	if (trimmed || !ctx.hasUI || typeof ctx.ui.select !== "function") return trimmed;

	const choice = await ctx.ui.select("Auto-compactación de contexto — elegí una configuración", MENU_OPTIONS);
	if (!choice) return "status"; // cancelado → no-op inofensivo (status)
	const command = choice.split(" — ")[0].trim();
	if (command !== "threshold") return command;

	const pick = await ctx.ui.select(
		"% de umbral de compactación (compacta cuando el uso llega a este nivel)",
		THRESHOLD_OPTIONS,
	);
	if (!pick) return "status";
	if (!pick.startsWith("personalizado")) return pick;
	if (typeof ctx.ui.input !== "function") return "status";
	const custom = await ctx.ui.input("Porcentaje de umbral personalizado (1\u201399)", "ej. 45");
	return (custom ?? "").trim() || "status";
}
