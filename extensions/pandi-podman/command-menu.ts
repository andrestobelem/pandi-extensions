import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export const PODMAN_ACTIONS = [
	{ value: "status", description: "resumen de Podman y sus recursos" },
	{ value: "list", description: "lista todos los contenedores" },
	{ value: "run", description: "ejecuta un sandbox efímero restringido" },
	{ value: "stop", description: "detiene un contenedor" },
	{ value: "remove", description: "elimina un contenedor (pide confirmación)" },
	{ value: "machine-list", description: "lista máquinas de Podman" },
	{ value: "machine-start", description: "inicia una máquina de Podman" },
] as const;

const ACTION_NAMES = PODMAN_ACTIONS.map(({ value }) => value);
export const PODMAN_SELECT_ITEMS = PODMAN_ACTIONS.map(({ value, description }) => `${value} — ${description}`);

export function completePodmanArgs(prefix: string): { value: string; label: string }[] | null {
	if (prefix.trim().split(/\s+/).length > 1) return null;
	const needle = prefix.trim().toLowerCase();
	const matches = ACTION_NAMES.filter((action) => action.startsWith(needle));
	return matches.length ? matches.map((value) => ({ value, label: value })) : null;
}

export async function resolvePodmanInput(input: string, ctx: ExtensionContext): Promise<string> {
	const trimmed = input.trim();
	if (trimmed || !ctx.hasUI || typeof ctx.ui?.select !== "function") return trimmed;
	const choice = await ctx.ui.select("Acción de Podman", PODMAN_SELECT_ITEMS);
	return choice?.split(/\s+/)[0] ?? "";
}
