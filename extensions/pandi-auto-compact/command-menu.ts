import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CODEX_DEFAULT_THRESHOLD_PERCENT, DEFAULT_THRESHOLD_PERCENT } from "./settings.js";

const MENU_ACTIONS = [
	{ value: "status", description: "mostrar la configuración actual" },
	{ value: "on", description: "activar la auto-compactación" },
	{ value: "off", description: "desactivar la auto-compactación" },
	{ value: "run", description: "compactar el contexto ahora" },
	{ value: "bar on", description: "mostrar la barra de progreso del footer" },
	{ value: "bar off", description: "ocultar la barra de progreso del footer" },
	{ value: "snapshot on", description: "mantener instantáneas recuperables antes de compactar" },
	{ value: "snapshot off", description: "dejar de guardar instantáneas" },
	{ value: "snapshots", description: "listar las instantáneas recientes" },
	{ value: "clear-tools on", description: "elidir salidas de tools viejas y grandes (más barato que compactar)" },
	{ value: "clear-tools off", description: "dejar de elidir salidas de tools viejas" },
	{ value: "threshold", description: "configurar el % de umbral de compactación" },
] as const;

// Menú interactivo que se muestra para un `/auto-compact` sin argumentos en una sesión con UI. El texto
// ANTES de " — " es el comando canónico que el manejador ya entiende.
export const MENU_OPTIONS = MENU_ACTIONS.map(({ value, description }) => `${value} — ${description}`);

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

// Items de autocompletado de argumentos. `value` se inserta en el editor al aceptar.
export const ARG_COMPLETIONS: { value: string; label: string; description: string }[] = [
	{ value: "status", label: "status", description: "Mostrar la configuración actual" },
	{ value: "on", label: "on", description: "Activar la auto-compactación" },
	{ value: "off", label: "off", description: "Desactivar la auto-compactación" },
	{ value: "run", label: "run", description: "Compactar el contexto ahora" },
	{ value: "bar", label: "bar", description: "Alternar la barra de progreso del footer" },
	{ value: "bar on", label: "bar on", description: "Mostrar la barra de progreso del footer" },
	{ value: "bar off", label: "bar off", description: "Ocultar la barra de progreso del footer" },
	{ value: "snapshot", label: "snapshot", description: "Alternar las instantáneas recuperables de compactación" },
	{
		value: "snapshot on",
		label: "snapshot on",
		description: "Mantener instantáneas recuperables antes de compactar",
	},
	{ value: "snapshot off", label: "snapshot off", description: "Dejar de guardar instantáneas" },
	{ value: "snapshots", label: "snapshots", description: "Listar las instantáneas recientes de esta sesión" },
	{
		value: "clear-tools",
		label: "clear-tools",
		description: "Alternar la elisión de salidas de tools viejas y grandes",
	},
	{
		value: "clear-tools on",
		label: "clear-tools on",
		description: "Elidir salidas de tools viejas y grandes en cada llamada al LLM",
	},
	{ value: "clear-tools off", label: "clear-tools off", description: "Dejar de elidir salidas de tools viejas" },
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
	if (trimmed || !ctx.hasUI) return trimmed;

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
	const custom = await ctx.ui.input("Porcentaje de umbral personalizado (1\u201399)", "ej. 45");
	return (custom ?? "").trim() || "status";
}
