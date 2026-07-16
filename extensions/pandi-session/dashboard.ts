import { existsSync } from "node:fs";
import * as path from "node:path";
import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { PandiSessionDashboard, type PandiSessionDashboardResult } from "./session-dashboard.js";
import {
	collectPandiSessions,
	formatPandiSessionList,
	type PandiSessionCleanupItem,
	type PandiSessionModel,
	prunePandiSessionFiles,
	sessionManagerMetadata,
} from "./session-registry.js";

type NotifyType = "info" | "warning" | "error";

type SwitchResult = { cancelled?: boolean } | undefined;

export interface PandiSessionCleanupArgs {
	dryRun: boolean;
	yes: boolean;
	includeHeartbeatStale: boolean;
}

type SwitchableSessionContext = ExtensionCommandContext & {
	switchSession?: (
		sessionFile: string,
		options?: { withSession?: (ctx: ExtensionContext) => void | Promise<void> },
	) => SwitchResult | Promise<SwitchResult>;
};

function notify(ctx: ExtensionCommandContext, message: string, type: NotifyType = "info"): void {
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

async function showSessionList(ctx: ExtensionCommandContext): Promise<void> {
	console.log(formatPandiSessionList(await collectPandiSessions(ctx as ExtensionContext)));
}

function quoteShellish(value: string): string {
	return JSON.stringify(value);
}

export function parsePandiSessionCleanupArgs(args: string): PandiSessionCleanupArgs {
	const result: PandiSessionCleanupArgs = { dryRun: false, yes: false, includeHeartbeatStale: false };
	const enableDryRun = (cleanupArgs: PandiSessionCleanupArgs) => {
		cleanupArgs.dryRun = true;
	};
	const enableYes = (cleanupArgs: PandiSessionCleanupArgs) => {
		cleanupArgs.yes = true;
	};
	const enableAllStale = (cleanupArgs: PandiSessionCleanupArgs) => {
		cleanupArgs.includeHeartbeatStale = true;
	};
	const flagEffects: Record<string, (cleanupArgs: PandiSessionCleanupArgs) => void> = {
		"--dry-run": enableDryRun,
		"-n": enableDryRun,
		"--yes": enableYes,
		"-y": enableYes,
		"--all-stale": enableAllStale,
	};
	for (const token of args.trim().split(/\s+/).filter(Boolean)) {
		flagEffects[token]?.(result);
	}
	return result;
}

function formatCleanupItem(item: PandiSessionCleanupItem): string {
	return `${item.action.padEnd(6)} ${item.file} — ${item.reason}`;
}

function formatCleanupDryRun(items: PandiSessionCleanupItem[], removed: string[], kept: number): string {
	const lines = [`Ensayo de limpieza de sesiones Pandi: ${removed.length} candidatas delete, ${kept} conservadas.`];
	if (items.length === 0) lines.push("No se encontraron archivos de sesión Pandi para este proyecto.");
	else lines.push(...items.map(formatCleanupItem));
	lines.push(removed.length ? "Ejecutá /sessions cleanup --yes para borrar las candidatas." : "Nada para borrar.");
	return lines.join("\n");
}

export async function switchToPandiSession(ctx: ExtensionCommandContext, session: PandiSessionModel): Promise<void> {
	const sessionFile = session.sessionFile;
	if (!sessionFile) {
		notify(ctx, "No se puede cambiar: la sesión Pandi seleccionada no registró un archivo de sesión.", "warning");
		return;
	}
	const currentFile = sessionManagerMetadata(ctx as ExtensionContext).sessionFile;
	if (currentFile && path.resolve(currentFile) === path.resolve(sessionFile)) {
		notify(ctx, "Ya estás en la sesión Pandi seleccionada.", "info");
		return;
	}
	const switchSession = (ctx as SwitchableSessionContext).switchSession;
	if (typeof switchSession !== "function") {
		notify(
			ctx,
			`No se puede cambiar desde este contexto. Reabrí manualmente con: pi -r ${quoteShellish(sessionFile)}`,
			"warning",
		);
		return;
	}
	if (!existsSync(sessionFile)) {
		notify(ctx, `No se puede cambiar: el archivo de sesión ya no existe: ${sessionFile}`, "warning");
		return;
	}
	const label = session.sessionName || session.sessionId || path.basename(sessionFile);
	const result = await switchSession(sessionFile, {
		withSession: async (nextCtx) => {
			nextCtx.ui.notify?.(`Cambiado a la sesión Pandi: ${label}`, "info");
		},
	});
	if (result && typeof result === "object" && result.cancelled) notify(ctx, "Cambio de sesión cancelado.", "warning");
}

async function cleanupStaleSessions(ctx: ExtensionCommandContext, rawArgs = ""): Promise<void> {
	const opts = parsePandiSessionCleanupArgs(rawArgs);
	const preview = await prunePandiSessionFiles(ctx as ExtensionContext, {
		dryRun: true,
		includeHeartbeatStale: opts.includeHeartbeatStale,
	});
	if (opts.dryRun) {
		notify(ctx, formatCleanupDryRun(preview.items, preview.removed, preview.kept), "info");
		return;
	}
	if (preview.removed.length === 0) {
		notify(ctx, "No hay archivos de sesión Pandi obsoletos para limpiar.", "info");
		return;
	}
	if (!ctx.hasUI && !opts.yes) {
		notify(ctx, "/sessions cleanup es destructivo; pasá --yes (o --dry-run) en modo sin UI.", "warning");
		return;
	}
	let ok = opts.yes;
	if (!opts.yes && ctx.hasUI && ctx.ui && typeof ctx.ui.confirm === "function") {
		ok = await ctx.ui.confirm(
			"¿Limpiar los archivos obsoletos de sesión Pandi?",
			`Esto elimina ${preview.removed.length} archivo(s) de sesión obsoletos. Las sesiones live y current nunca se tocan.`,
		);
	} else if (!opts.yes) {
		notify(
			ctx,
			"/sessions cleanup es destructivo; pasá --yes (o --dry-run) cuando no haya confirmación disponible.",
			"warning",
		);
		return;
	}
	if (!ok) return;
	const result = await prunePandiSessionFiles(ctx as ExtensionContext, {
		includeHeartbeatStale: opts.includeHeartbeatStale,
	});
	notify(
		ctx,
		`Se eliminaron ${result.removed.length} archivo(s) de sesión Pandi obsoletos; se conservaron ${result.kept}.`,
		"info",
	);
}

async function handleDashboardResult(ctx: ExtensionCommandContext, result: PandiSessionDashboardResult): Promise<void> {
	if (!result) return;
	if (result.type === "cleanup") {
		await cleanupStaleSessions(ctx);
		return;
	}
	await switchToPandiSession(ctx, result.session);
}

export async function openPandiSessionDashboard(ctx: ExtensionCommandContext): Promise<void> {
	if (!ctx.hasUI || typeof ctx.ui?.custom !== "function") {
		await showSessionList(ctx);
		return;
	}
	let dashboard: PandiSessionDashboard | undefined;
	let refreshTimer: NodeJS.Timeout | undefined;
	let refreshing = false;
	let closed = false;
	const initialSessions = await collectPandiSessions(ctx as ExtensionContext);
	try {
		const result = await ctx.ui.custom<PandiSessionDashboardResult>((tui, theme, _keybindings, done) => {
			dashboard = new PandiSessionDashboard(initialSessions, theme, () => tui.requestRender(), done);
			const refresh = async () => {
				if (closed || refreshing || !dashboard) return;
				refreshing = true;
				try {
					const sessions = await collectPandiSessions(ctx as ExtensionContext);
					if (closed) return;
					dashboard.setSessions(sessions);
					dashboard.markRefreshOk();
					tui.requestRender();
				} catch (err) {
					if (closed) return;
					dashboard.markRefreshError(err instanceof Error ? err.message : String(err));
					tui.requestRender();
				} finally {
					refreshing = false;
				}
			};
			refreshTimer = setInterval(() => void refresh(), 1500);
			refreshTimer.unref?.();
			return dashboard;
		});
		await handleDashboardResult(ctx, result ?? null);
	} finally {
		closed = true;
		if (refreshTimer) clearInterval(refreshTimer);
	}
}

export async function listPandiSessions(ctx: ExtensionCommandContext): Promise<void> {
	await showSessionList(ctx);
}

export async function cleanupPandiSessions(ctx: ExtensionCommandContext, args = ""): Promise<void> {
	await cleanupStaleSessions(ctx, args);
}
