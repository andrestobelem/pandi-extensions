import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { PandiSessionDashboard, type PandiSessionDashboardResult } from "./session-dashboard.js";
import {
	collectPandiSessions,
	formatPandiSessionList,
	type PandiSessionModel,
	prunePandiSessionFiles,
	startPandiSessionHeartbeat,
	stopPandiSessionHeartbeat,
} from "./session-registry.js";

function canUseDashboard(ctx: ExtensionCommandContext): boolean {
	return Boolean(ctx.hasUI && typeof ctx.ui?.custom === "function");
}

function notify(ctx: ExtensionCommandContext, message: string, type: "info" | "warning" | "error" = "info"): void {
	if (ctx.mode === "print" || !ctx.hasUI) {
		if (type === "info") console.log(message);
		else console.error(message);
		return;
	}
	ctx.ui.notify(message, type);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function cleanupStaleSessions(ctx: ExtensionCommandContext): Promise<number> {
	const result = await prunePandiSessionFiles(ctx as ExtensionContext, { includeHeartbeatStale: true });
	return result.removed.length;
}

async function switchSession(ctx: ExtensionCommandContext, session: PandiSessionModel): Promise<void> {
	const file = session.sessionFile;
	if (!file) {
		notify(ctx, "Esa sesión no tiene archivo de transcript asociado.", "warning");
		return;
	}
	if (typeof ctx.switchSession === "function") {
		await ctx.switchSession(file);
		return;
	}
	notify(ctx, `Abrí la sesión con: pi -r ${file}`, "info");
}

async function openDashboard(ctx: ExtensionCommandContext): Promise<PandiSessionDashboardResult> {
	if (!canUseDashboard(ctx)) {
		console.log(formatPandiSessionList(await collectPandiSessions(ctx as ExtensionContext)));
		return null;
	}
	const sessions = await collectPandiSessions(ctx as ExtensionContext);
	return await ctx.ui.custom<PandiSessionDashboardResult>((tui, theme, _keybindings, done) => {
		return new PandiSessionDashboard(sessions, theme, () => tui.requestRender(), done);
	});
}

async function handleDashboardResult(ctx: ExtensionCommandContext, result: PandiSessionDashboardResult): Promise<void> {
	if (!result) return;
	if (result.type === "cleanup") {
		const removed = await cleanupStaleSessions(ctx);
		notify(ctx, `Sesiones stale limpiadas: ${removed}.`, "info");
		return;
	}
	await switchSession(ctx, result.session);
}

async function handleSession(args: string, ctx: ExtensionCommandContext): Promise<void> {
	try {
		const trimmed = args.trim();
		if (trimmed === "list") {
			console.log(formatPandiSessionList(await collectPandiSessions(ctx as ExtensionContext)));
			return;
		}
		if (trimmed === "cleanup") {
			const removed = await cleanupStaleSessions(ctx);
			notify(ctx, `Sesiones stale limpiadas: ${removed}.`, "info");
			return;
		}
		const result = await openDashboard(ctx);
		await handleDashboardResult(ctx, result ?? null);
	} catch (error) {
		notify(ctx, `No se pudo abrir /session: ${errorMessage(error)}`, "error");
	}
}

export default function pandiSession(pi: ExtensionAPI): void {
	pi.on("session_start", (event, ctx) => startPandiSessionHeartbeat(event, ctx));
	pi.on("session_shutdown", () => stopPandiSessionHeartbeat());
	pi.registerCommand("session", {
		description: "Abrí el dashboard de sesiones Pandi de este proyecto.",
		handler: handleSession,
	});
	pi.registerCommand("sessions", {
		description: "Alias de /session; usá `/sessions list` para salida textual.",
		handler: handleSession,
	});
}
