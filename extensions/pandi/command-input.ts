import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const PANDI_ACTIONS = [
	{ value: "status", selectLabel: "status — estado + saludo de Pandi" },
	{ value: "on", selectLabel: "on — despertar a Pandi" },
	{ value: "off", selectLabel: "off — mandar a Pandi a dormir" },
	{ value: "art", selectLabel: "art — mostrar/ocultar el splash del panda" },
	{ value: "face", selectLabel: "face — cambiar la carita del indicador" },
] as const;

const PANDI_STATUS_ACTION = PANDI_ACTIONS[0].value;

/** Opciones del selector de `/pandi` sin argumentos (el primer token mapea al subcomando). */
export const PANDI_SELECT_ITEMS = PANDI_ACTIONS.map(({ selectLabel }) => selectLabel);

/**
 * Resuelve el argumento de `/pandi`. Sin argumentos y con UI abre el selector interactivo;
 * elegir "status" mapea al saludo/estado (subcomando vacío).
 */
export async function resolvePandiInput(input: string, ctx: ExtensionContext): Promise<string> {
	const trimmed = input.trim();
	if (trimmed || !ctx.hasUI || typeof ctx.ui?.select !== "function") return trimmed;
	const choice = await ctx.ui.select("Pandi 🐼", PANDI_SELECT_ITEMS);
	const token = choice?.split(/\s+/)[0] ?? "";
	return token === PANDI_STATUS_ACTION ? "" : token;
}
