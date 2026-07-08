import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { cleanupPandiSessions, listPandiSessions, openPandiSessionDashboard } from "./dashboard.js";
import { startPandiSessionHeartbeat, stopPandiSessionHeartbeat } from "./session-registry.js";

const PANDI_SESSION_ACTIONS = [
	{ value: "dashboard", description: "abrir el panel de sesiones" },
	{ value: "list", description: "listar las sesiones del proyecto" },
	{ value: "cleanup", description: "limpiar registros stale seguros" },
] as const;

function formatPandiSessionSelectItem(action: (typeof PANDI_SESSION_ACTIONS)[number]): string {
	return `${action.value} — ${action.description}`;
}

export const PANDI_SESSION_SELECT_ITEMS = PANDI_SESSION_ACTIONS.map(formatPandiSessionSelectItem);

function selectedPandiSessionActionValue(choice: string | undefined): string | undefined {
	if (choice === undefined) return undefined;
	const action = PANDI_SESSION_ACTIONS.find((candidate) => choice === formatPandiSessionSelectItem(candidate));
	return action?.value ?? choice.split(/\s+/)[0];
}

export async function resolvePandiSessionInput(
	input: string,
	ctx: ExtensionCommandContext,
): Promise<string | undefined> {
	const trimmed = input.trim();
	if (trimmed || !ctx.hasUI || typeof ctx.ui?.select !== "function") return trimmed;
	const choice = await ctx.ui.select("Sesiones Pandi", PANDI_SESSION_SELECT_ITEMS);
	return selectedPandiSessionActionValue(choice);
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
		description: "Abre el menú/dashboard de sesiones Pandi; usá `/sessions list` para salida textual.",
		handler: handleSession,
	});
}
