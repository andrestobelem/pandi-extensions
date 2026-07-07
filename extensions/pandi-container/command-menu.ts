import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { TIER_NAMES } from "./container.js";

export const CONTAINER_ACTIONS = [
	{ value: "status", selectLabel: "status — resumen del subsistema y las máquinas" },
	{ value: "list", selectLabel: "list — lista las máquinas del contenedor" },
	{ value: "create", selectLabel: "create — crea una máquina a partir de una imagen OCI" },
	{ value: "run", selectLabel: "run — ejecuta un comando en una máquina o en un contenedor efímero" },
	{ value: "stop", selectLabel: "stop — detiene una máquina" },
	{ value: "remove", selectLabel: "remove — elimina una máquina (pide confirmación)" },
] as const;

/** Opciones con etiqueta humana para el selector de acciones de `/container` sin argumentos (el primer token es el valor). */
export const CONTAINER_SELECT_ITEMS = CONTAINER_ACTIONS.map(({ selectLabel }) => selectLabel);

const SUBCOMMANDS = CONTAINER_ACTIONS.map(({ value }) => value);

export function completeContainerArgs(prefix: string): { value: string; label: string }[] | null {
	const tokens = prefix.split(/\s+/);
	if (tokens.length > 1) {
		// `create … --size <tier>`: completa los nombres de nivel.
		const prev = tokens[tokens.length - 2];
		if (tokens[0] === "create" && (prev === "--size" || prev === "--tier")) {
			const needle = (tokens[tokens.length - 1] ?? "").toLowerCase();
			const tiers = TIER_NAMES.filter((t) => t.startsWith(needle));
			return tiers.length > 0 ? tiers.map((t) => ({ value: t, label: t })) : null;
		}
		return null;
	}
	const needle = (tokens[0] ?? "").toLowerCase();
	const items = SUBCOMMANDS.filter((sub) => sub.startsWith(needle));
	return items.length > 0 ? items.map((sub) => ({ value: sub, label: sub })) : null;
}

/**
 * Resuelve el argumento de `/container`, abriendo un selector interactivo de acciones cuando el
 * comando se invoca sin args en una sesión con UI. Sin UI (headless) y los args explícitos
 * mantienen el comportamiento intacto, así nada se rompe fuera del TUI. Cancelar devuelve "",
 * que `runCommand` renderiza como texto de ayuda.
 */
export async function resolveContainerInput(input: string, ctx: ExtensionContext): Promise<string> {
	const trimmed = input.trim();
	if (trimmed || !ctx.hasUI || typeof ctx.ui?.select !== "function") return trimmed;
	const choice = await ctx.ui.select("Acción de container", CONTAINER_SELECT_ITEMS);
	return choice?.split(/\s+/)[0] ?? "";
}
