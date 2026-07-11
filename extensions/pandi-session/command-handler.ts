import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { cleanupPandiSessions, listPandiSessions, openPandiSessionDashboard } from "./dashboard.js";
import { errorMessage, notify } from "./notify.js";
import { resolvePandiSessionInput } from "./session-input.js";

export async function handleSessionCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
	try {
		const resolved = await resolvePandiSessionInput(args, ctx);
		if (resolved === undefined) return;
		const trimmed = resolved.trim();
		const [action = "", ...rest] = trimmed.split(/\s+/);
		const tail = rest.join(" ");
		if (trimmed === "" || action === "dashboard" || action === "tui") {
			await openPandiSessionDashboard(ctx);
			return;
		}
		if (action === "list") {
			await listPandiSessions(ctx);
			return;
		}
		if (action === "cleanup") {
			await cleanupPandiSessions(ctx, tail);
			return;
		}
		notify(ctx, "Uso: /sessions [dashboard|list|cleanup]", "warning");
	} catch (error) {
		notify(ctx, `No se pudo abrir /sessions: ${errorMessage(error)}`, "error");
	}
}
