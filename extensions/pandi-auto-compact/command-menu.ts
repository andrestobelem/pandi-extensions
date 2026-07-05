import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CODEX_DEFAULT_THRESHOLD_PERCENT, DEFAULT_THRESHOLD_PERCENT } from "./settings.js";

// Interactive menu shown for a bare `/auto-compact` in a UI session. The text
// BEFORE " — " is the canonical command the handler already understands.
export const MENU_OPTIONS = [
	"status — mostrar la configuración actual",
	"on — activar la auto-compactación",
	"off — desactivar la auto-compactación",
	"run — compactar el contexto ahora",
	"bar on — mostrar la barra de progreso del footer",
	"bar off — ocultar la barra de progreso del footer",
	"snapshot on — mantener instantáneas recuperables antes de compactar",
	"snapshot off — dejar de guardar instantáneas",
	"snapshots — listar las instantáneas recientes",
	"clear-tools on — elidir salidas de tools viejas y grandes (más barato que compactar)",
	"clear-tools off — dejar de elidir salidas de tools viejas",
	"threshold — configurar el % de umbral de compactación",
];

// Threshold presets offered after choosing "threshold"; derived so the current default
// is always present (and marked below). The last entry opens a text input.
const THRESHOLD_PRESETS = [
	...new Set([20, 30, 40, 50, 60, 70, 80, DEFAULT_THRESHOLD_PERCENT, CODEX_DEFAULT_THRESHOLD_PERCENT]),
].sort((a, b) => a - b);
export const THRESHOLD_OPTIONS = [...THRESHOLD_PRESETS.map(String), "personalizado\u2026"];

// Argument autocomplete items. `value` is inserted into the editor on accept.
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
		description: `Configurar el umbral al ${p}%${p === DEFAULT_THRESHOLD_PERCENT ? " (predeterminado)" : p === CODEX_DEFAULT_THRESHOLD_PERCENT ? " (predeterminado de Codex)" : ""}`,
	})),
];

// When invoked bare in a UI session, open a menu to pick a setting (and a second
// menu/input for the threshold value); otherwise return the typed args unchanged.
// Returns a string the command handler already understands.
export async function resolveCommandValue(args: string, ctx: ExtensionContext): Promise<string> {
	const trimmed = args.trim();
	if (trimmed || !ctx.hasUI) return trimmed;

	const choice = await ctx.ui.select("Auto-compactación de contexto — elegí una configuración", MENU_OPTIONS);
	if (!choice) return "status"; // cancelled → harmless no-op (status)
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
