import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ActiveLoop, LoopStatus } from "./state.js";

/**
 * Resuelve un loop por id, por candidato único o vía ui.select.
 *
 * `statuses` filtra qué loops son elegibles (p. ej. ["running"] para pause,
 * ["running", "paused"] para stop). Sin id y con múltiples candidatos, solo una
 * sesión con UI puede desambiguar; en headless devuelve undefined.
 */
export async function resolveLoop(
	ctx: ExtensionContext,
	activeLoops: ReadonlyMap<string, ActiveLoop>,
	idOrUndef: string | undefined,
	statuses: readonly LoopStatus[] = ["running"],
): Promise<ActiveLoop | undefined> {
	if (idOrUndef) {
		const loop = activeLoops.get(idOrUndef);
		return loop && statuses.includes(loop.status) ? loop : undefined;
	}
	const candidates = [...activeLoops.values()].filter((loop) => statuses.includes(loop.status));
	if (candidates.length === 0) return undefined;
	if (candidates.length === 1) return candidates[0];
	if (ctx.hasUI) {
		const choice = await ctx.ui.select(
			"¿Qué loop?",
			candidates.map((loop) => `${loop.loopId} — ${loop.task}`),
		);
		if (!choice) return undefined;
		const id = choice.split(" ")[0];
		return activeLoops.get(id);
	}
	return undefined;
}
