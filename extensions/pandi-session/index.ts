import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { cleanupPandiSessions, listPandiSessions, openPandiSessionDashboard } from "./dashboard.js";
import { startPandiSessionHeartbeat, stopPandiSessionHeartbeat } from "./session-registry.js";

export const PANDI_SESSION_SELECT_ITEMS = [
	"dashboard — abrir el dashboard de sesiones",
	"list — listar sesiones del proyecto",
	"cleanup — limpiar registros stale seguros",
];

export async function resolvePandiSessionInput(
	input: string,
	ctx: ExtensionCommandContext,
): Promise<string | undefined> {
	const trimmed = input.trim();
	if (trimmed || !ctx.hasUI || typeof ctx.ui?.select !== "function") return trimmed;
	const choice = await ctx.ui.select("Pandi sessions", PANDI_SESSION_SELECT_ITEMS);
	return choice?.split(/\s+/)[0];
}

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

export default function pandiSession(pi: ExtensionAPI): void {
	pi.on("session_start", (event, ctx) => startPandiSessionHeartbeat(event, ctx));
	pi.on("session_shutdown", () => stopPandiSessionHeartbeat());
	pi.registerCommand("sessions", {
		description: "Abrí el menú/dashboard de sesiones Pandi; usá `/sessions list` para salida textual.",
		handler: handleSession,
	});
}
