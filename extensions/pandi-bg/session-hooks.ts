import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { canRunInMode } from "./command-handlers.js";
import { reconcileInterruptedJobs } from "./reconcile.js";

export function registerBgSessionHooks(pi: ExtensionAPI): void {
	// Self-heal al startup (solo sesiones persistentes y confiables, donde se poseen jobs):
	// reescribe jobs locales del proyecto cuyo pid registrado está muerto, de `running` stale
	// a `interrupted` terminal, para que el artifact en disco deje de afirmar `running`.
	pi.on("session_start", async (_event, ctx) => {
		if (!canRunInMode(ctx)) return;
		try {
			await reconcileInterruptedJobs(ctx);
		} catch {
			// ignore: reconcile es bookkeeping no crítico
		}
	});
}
