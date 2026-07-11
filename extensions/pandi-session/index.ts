/**
 * Dashboard /sessions independiente: descubre sesiones Pandi locales por proyecto.
 *
 * - dashboard.ts / session-registry.ts — lógica de panel y heartbeat
 * - command-handler.ts — handler de `/sessions`
 * - session-input.ts — resolución interactiva del subcomando
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { handleSessionCommand } from "./command-handler.js";
import { registerSessionHooks } from "./session-hooks.js";

export { PANDI_SESSION_SELECT_ITEMS } from "./session-actions.js";
export { resolvePandiSessionInput } from "./session-input.js";

export default function pandiSession(pi: ExtensionAPI): void {
	registerSessionHooks(pi);
	pi.registerCommand("sessions", {
		description: "Abre el menú/dashboard de sesiones Pandi; usá `/sessions list` para salida textual.",
		handler: handleSessionCommand,
	});
}
