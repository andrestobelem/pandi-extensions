import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { rehydrate } from "./engine.js";
import { handleAgentEnd, handleSessionShutdown } from "./lifecycle.js";

export function handleGoalSessionStart(pi: ExtensionAPI, event: { reason: string }, ctx: ExtensionContext): void {
	// NO migrar un goal a una sesión bifurcada: un fork hereda las entradas
	// "goal-state" del padre, pero el goal debe seguir corriendo solo en el padre.
	if (event.reason === "fork") return;
	rehydrate(pi, ctx);
}

export function registerGoalSessionHooks(pi: ExtensionAPI): void {
	pi.on("session_start", async (event, ctx) => handleGoalSessionStart(pi, event, ctx));
	pi.on("session_shutdown", async (_event, ctx) => handleSessionShutdown(pi, ctx));
	pi.on("agent_end", async (_event, ctx) => handleAgentEnd(pi, ctx));
}
