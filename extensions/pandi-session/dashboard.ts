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
	for (const token of args.trim().split(/\s+/).filter(Boolean)) {
		if (token === "--dry-run" || token === "-n") result.dryRun = true;
		else if (token === "--yes" || token === "-y") result.yes = true;
		else if (token === "--all-stale") result.includeHeartbeatStale = true;
	}
	return result;
}

function formatCleanupItem(item: PandiSessionCleanupItem): string {
	return `${item.action.padEnd(6)} ${item.file} — ${item.reason}`;
}

function formatCleanupDryRun(items: PandiSessionCleanupItem[], removed: string[], kept: number): string {
	const lines = [`Pandi session cleanup dry-run: ${removed.length} delete candidate(s), ${kept} kept.`];
	if (items.length === 0) lines.push("No Pandi session files found for this project.");
	else lines.push(...items.map(formatCleanupItem));
	lines.push(removed.length ? "Run /sessions cleanup --yes to delete candidates." : "Nothing to delete.");
	return lines.join("\n");
}

export async function switchToPandiSession(ctx: ExtensionCommandContext, session: PandiSessionModel): Promise<void> {
	const sessionFile = session.sessionFile;
	if (!sessionFile) {
		notify(ctx, "Cannot switch: selected Pandi session did not record a session file.", "warning");
		return;
	}
	const currentFile = sessionManagerMetadata(ctx as ExtensionContext).sessionFile;
	if (currentFile && path.resolve(currentFile) === path.resolve(sessionFile)) {
		notify(ctx, "Already in the selected Pandi session.", "info");
		return;
	}
	const switchSession = (ctx as SwitchableSessionContext).switchSession;
	if (typeof switchSession !== "function") {
		notify(
			ctx,
			`Cannot switch from this context. Reopen manually with: pi -r ${quoteShellish(sessionFile)}`,
			"warning",
		);
		return;
	}
	if (!existsSync(sessionFile)) {
		notify(ctx, `Cannot switch: session file no longer exists: ${sessionFile}`, "warning");
		return;
	}
	const label = session.sessionName || session.sessionId || path.basename(sessionFile);
	const result = await switchSession(sessionFile, {
		withSession: async (nextCtx) => {
			nextCtx.ui.notify?.(`Switched to Pandi session: ${label}`, "info");
		},
	});
	if (result && typeof result === "object" && result.cancelled) notify(ctx, "Session switch cancelled.", "warning");
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
		notify(ctx, "No stale Pandi session files to clean up.", "info");
		return;
	}
	if (!ctx.hasUI && !opts.yes) {
		notify(ctx, "/sessions cleanup is destructive; pass --yes (or --dry-run) in no-UI mode.", "warning");
		return;
	}
	let ok = opts.yes;
	if (!opts.yes && ctx.hasUI && ctx.ui && typeof ctx.ui.confirm === "function") {
		ok = await ctx.ui.confirm(
			"Clean up stale Pandi session files?",
			`This removes ${preview.removed.length} stale session file(s). Live and current sessions are never touched.`,
		);
	} else if (!opts.yes) {
		notify(
			ctx,
			"/sessions cleanup is destructive; pass --yes (or --dry-run) when confirmation is unavailable.",
			"warning",
		);
		return;
	}
	if (!ok) return;
	const result = await prunePandiSessionFiles(ctx as ExtensionContext, {
		includeHeartbeatStale: opts.includeHeartbeatStale,
	});
	notify(ctx, `Removed ${result.removed.length} stale Pandi session file(s); kept ${result.kept}.`, "info");
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
	const initialSessions = await collectPandiSessions(ctx as ExtensionContext);
	try {
		const result = await ctx.ui.custom<PandiSessionDashboardResult>((tui, theme, _keybindings, done) => {
			dashboard = new PandiSessionDashboard(initialSessions, theme, () => tui.requestRender(), done);
			const refresh = async () => {
				if (refreshing || !dashboard) return;
				refreshing = true;
				try {
					dashboard.setSessions(await collectPandiSessions(ctx as ExtensionContext));
					dashboard.markRefreshOk();
					tui.requestRender();
				} catch (err) {
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
		if (refreshTimer) clearInterval(refreshTimer);
	}
}

export async function listPandiSessions(ctx: ExtensionCommandContext): Promise<void> {
	await showSessionList(ctx);
}

export async function cleanupPandiSessions(ctx: ExtensionCommandContext, args = ""): Promise<void> {
	await cleanupStaleSessions(ctx, args);
}
