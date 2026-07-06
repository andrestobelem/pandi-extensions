import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { cleanupPandiSessions, listPandiSessions, openPandiSessionDashboard } from "./dashboard.js";
import { startPandiSessionHeartbeat, stopPandiSessionHeartbeat } from "./session-registry.js";

function notify(ctx: ExtensionCommandContext, message: string, type: "info" | "warning" | "error" = "info"): void {
	if (ctx.mode === "print") {
		(type === "info" ? console.log : console.error)(message);
		return;
	}
	if (ctx.hasUI && ctx.ui) {
		ctx.ui.notify(message, type);
		return;
	}
	if (type !== "info") console.error(message);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function handleSession(args: string, ctx: ExtensionCommandContext): Promise<void> {
	try {
		const trimmed = args.trim();
		if (trimmed === "list") {
			await listPandiSessions(ctx);
			return;
		}
		if (trimmed === "cleanup") {
			await cleanupPandiSessions(ctx);
			return;
		}
		await openPandiSessionDashboard(ctx);
	} catch (error) {
		notify(ctx, `No se pudo abrir /sessions: ${errorMessage(error)}`, "error");
	}
}

export default function pandiSession(pi: ExtensionAPI): void {
	pi.on("session_start", (event, ctx) => startPandiSessionHeartbeat(event, ctx));
	pi.on("session_shutdown", () => stopPandiSessionHeartbeat());
	pi.registerCommand("sessions", {
		description: "Abrí el dashboard de sesiones Pandi; usá `/sessions list` para salida textual.",
		handler: handleSession,
	});
}
