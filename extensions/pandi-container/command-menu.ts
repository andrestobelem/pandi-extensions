import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export const CONTAINER_ACTIONS = [
	{ value: "status", selectLabel: "status — resumen del subsistema y las máquinas" },
	{ value: "list", selectLabel: "list — lista las máquinas del contenedor" },
	{ value: "create", selectLabel: "create — crea una máquina a partir de una imagen OCI" },
	{ value: "run", selectLabel: "run — ejecuta un comando en una máquina o en un contenedor efímero" },
	{ value: "stop", selectLabel: "stop — detiene una máquina" },
	{ value: "remove", selectLabel: "remove — elimina una máquina (pide confirmación)" },
] as const;

/** Opciones con etiqueta humana para el selector de acciones de `/container` sin args (el primer token es el valor). */
export const CONTAINER_SELECT_ITEMS = CONTAINER_ACTIONS.map(({ selectLabel }) => selectLabel);

/**
 * Resuelve el argumento de `/container`, abriendo un selector interactivo de acciones cuando el
 * comando se invoca sin args en una sesión con UI. Sin UI (headless) y los args explícitos
 * mantienen el comportamiento intacto, así nada se rompe fuera del TUI. Cancelar devuelve "",
 * que `runCommand` renderiza como texto de ayuda.
 */
export async function resolveContainerInput(input: string, ctx: ExtensionContext): Promise<string> {
	const trimmed = input.trim();
	if (trimmed || !ctx.hasUI || typeof ctx.ui?.select !== "function") return trimmed;
	const choice = await ctx.ui.select("Container action", CONTAINER_SELECT_ITEMS);
	return choice?.split(/\s+/)[0] ?? "";
}
