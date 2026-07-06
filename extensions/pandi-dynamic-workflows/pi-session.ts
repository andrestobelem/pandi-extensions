/**
 * Pi session tracking — el on-disk session record/heartbeat lifecycle que permite al
 * dashboard listar y cambiar a otros live Pi sessions para este proyecto.
 *
 * PiSessionRecord/LivePiSessionRuntime son module-internal; PiSessionModel (el enriched
 * record que el dashboard renderiza) se exporta, así como los live-session path helpers.
 * Deferred cycle: los heartbeat/root helpers leen ensureDir/projectHash desde workflow-resolve.ts
 * y el contador de runs activos desde run-registry.ts solo dentro de sus bodies; PI_SESSION_HEARTBEAT_MS
 * viene de runtime-constants.ts, e index.ts importa los session helpers de vuelta (invocados solo en session_start/session_end handlers y
 * dashboard body). Extraído byte-idénticamente (cluster + los cuatro live-session symbols
 * que fueron sus únicos usuarios).
 */

import * as crypto from "node:crypto";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { formatElapsedMs } from "./presentation.js";
import { activeRunCount } from "./run-registry.js";
import { writeJsonFile } from "./run-store.js";
import { PI_SESSION_HEARTBEAT_MS } from "./runtime-constants.js";
import { ensureDir, projectHash } from "./workflow-resolve.js";

const PI_LIVE_SESSION_DIR = "live-sessions";
const PI_SESSION_STALE_MS = 20_000;

function getLiveSessionRoot(ctx: ExtensionContext): string {
	if (ctx.isProjectTrusted()) return path.join(ctx.cwd, CONFIG_DIR_NAME, PI_LIVE_SESSION_DIR);
	return path.join(getAgentDir(), PI_LIVE_SESSION_DIR, projectHash(ctx.cwd));
}

function getLiveSessionRoots(ctx: ExtensionContext): string[] {
	const roots = [path.join(getAgentDir(), PI_LIVE_SESSION_DIR, projectHash(ctx.cwd))];
	if (ctx.isProjectTrusted()) roots.unshift(path.join(ctx.cwd, CONFIG_DIR_NAME, PI_LIVE_SESSION_DIR));
	return [...new Set(roots)];
}

interface PiSessionRecord {
	id: string;
	pid: number;
	mode: string;
	cwd: string;
	startedAt: string;
	updatedAt: string;
	reason?: string;
	sessionId?: string;
	sessionFile?: string;
	sessionName?: string;
	trusted?: boolean;
	idle?: boolean;
	activeWorkflowRuns?: number;
}

export interface PiSessionModel extends PiSessionRecord {
	file: string;
	live: boolean;
	current: boolean;
	ageMs: number;
	staleReason?: string;
}

interface LivePiSessionRuntime {
	id: string;
	ctx: ExtensionContext;
	file: string;
	startedAt: string;
	reason: string;
	timer?: NodeJS.Timeout;
}

let livePiSession: LivePiSessionRuntime | undefined;

function isPersistentPiSessionMode(mode: string): boolean {
	return mode === "tui" || mode === "rpc";
}

export function sessionManagerMetadata(ctx: ExtensionContext): {
	sessionId?: string;
	sessionFile?: string;
	sessionName?: string;
} {
	const manager = ctx.sessionManager as unknown as {
		getSessionId?: () => string;
		getSessionFile?: () => string | undefined;
		getSessionName?: () => string | undefined;
	};
	return {
		sessionId: manager.getSessionId?.(),
		sessionFile: manager.getSessionFile?.(),
		sessionName: manager.getSessionName?.(),
	};
}

function buildPiSessionRecord(runtime: LivePiSessionRuntime): PiSessionRecord {
	const { ctx } = runtime;
	const metadata = sessionManagerMetadata(ctx);
	return {
		id: runtime.id,
		pid: process.pid,
		mode: ctx.mode,
		cwd: ctx.cwd,
		startedAt: runtime.startedAt,
		updatedAt: new Date().toISOString(),
		reason: runtime.reason,
		...metadata,
		trusted: ctx.isProjectTrusted(),
		idle: ctx.isIdle(),
		activeWorkflowRuns: activeRunCount(),
	};
}

async function writePiSessionHeartbeat(runtime: LivePiSessionRuntime): Promise<void> {
	try {
		await ensureDir(path.dirname(runtime.file));
		await writeJsonFile(runtime.file, buildPiSessionRecord(runtime));
	} catch {
		// Heartbeats son best-effort; el dashboard nunca debe fallar porque el
		// live-session registry no se puede escribir (p. ej. permissions o tmp cleanup).
	}
}

export async function startPiSessionHeartbeat(event: { reason: string }, ctx: ExtensionContext): Promise<void> {
	await stopPiSessionHeartbeat();
	if (!isPersistentPiSessionMode(ctx.mode)) return;
	const id = `${Date.now().toString(36)}-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
	const runtime: LivePiSessionRuntime = {
		id,
		ctx,
		file: path.join(getLiveSessionRoot(ctx), `${id}.json`),
		startedAt: new Date().toISOString(),
		reason: event.reason,
	};
	livePiSession = runtime;
	await writePiSessionHeartbeat(runtime);
	runtime.timer = setInterval(() => void writePiSessionHeartbeat(runtime), PI_SESSION_HEARTBEAT_MS);
	runtime.timer.unref?.();
}

export async function stopPiSessionHeartbeat(): Promise<void> {
	const runtime = livePiSession;
	livePiSession = undefined;
	if (!runtime) return;
	if (runtime.timer) clearInterval(runtime.timer);
	await fs.rm(runtime.file, { force: true }).catch(() => undefined);
}

function isPidAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

function parsePiSessionRecord(value: unknown): PiSessionRecord | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	if (typeof record.id !== "string" || typeof record.cwd !== "string" || typeof record.mode !== "string")
		return undefined;
	if (typeof record.startedAt !== "string" || typeof record.updatedAt !== "string") return undefined;
	if (typeof record.pid !== "number" || !Number.isInteger(record.pid)) return undefined;
	return {
		id: record.id,
		pid: record.pid,
		mode: record.mode,
		cwd: record.cwd,
		startedAt: record.startedAt,
		updatedAt: record.updatedAt,
		...(typeof record.reason === "string" ? { reason: record.reason } : {}),
		...(typeof record.sessionId === "string" ? { sessionId: record.sessionId } : {}),
		...(typeof record.sessionFile === "string" ? { sessionFile: record.sessionFile } : {}),
		...(typeof record.sessionName === "string" ? { sessionName: record.sessionName } : {}),
		...(typeof record.trusted === "boolean" ? { trusted: record.trusted } : {}),
		...(typeof record.idle === "boolean" ? { idle: record.idle } : {}),
		...(typeof record.activeWorkflowRuns === "number" && Number.isFinite(record.activeWorkflowRuns)
			? { activeWorkflowRuns: record.activeWorkflowRuns }
			: {}),
	};
}

async function readPiSessionRecord(file: string): Promise<PiSessionRecord | undefined> {
	try {
		return parsePiSessionRecord(JSON.parse(await fs.readFile(file, "utf8")));
	} catch {
		return undefined;
	}
}

export async function collectPiSessions(ctx: ExtensionContext): Promise<PiSessionModel[]> {
	const now = Date.now();
	const byId = new Map<string, PiSessionModel>();
	for (const root of getLiveSessionRoots(ctx)) {
		if (!existsSync(root)) continue;
		let entries: import("node:fs").Dirent[];
		try {
			entries = await fs.readdir(root, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
			const file = path.join(root, entry.name);
			const record = await readPiSessionRecord(file);
			if (record?.cwd !== ctx.cwd || !isPersistentPiSessionMode(record.mode)) continue;
			const updatedMs = Date.parse(record.updatedAt);
			const ageMs = Number.isFinite(updatedMs) ? Math.max(0, now - updatedMs) : Number.POSITIVE_INFINITY;
			const pidAlive = isPidAlive(record.pid);
			const fresh = Number.isFinite(ageMs) && ageMs <= PI_SESSION_STALE_MS;
			const live = pidAlive && fresh;
			const staleReason = live ? undefined : !pidAlive ? "pid exited" : !fresh ? "heartbeat stale" : "unknown";
			const model: PiSessionModel = {
				...record,
				file,
				live,
				current: record.id === livePiSession?.id,
				ageMs,
				...(staleReason ? { staleReason } : {}),
			};
			const previous = byId.get(record.id);
			if (!previous || model.live || model.ageMs < previous.ageMs) byId.set(record.id, model);
		}
	}
	return [...byId.values()].sort((a, b) => {
		if (a.current !== b.current) return a.current ? -1 : 1;
		if (a.live !== b.live) return a.live ? -1 : 1;
		return Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
	});
}

export function formatPiSessionList(sessions: PiSessionModel[]): string {
	if (sessions.length === 0) return "No live Pi TUI/RPC sessions found for this project.";
	const lines = [`Pi sessions (${sessions.length})`];
	for (const session of sessions) {
		const status = session.live ? "live" : `stale${session.staleReason ? `:${session.staleReason}` : ""}`;
		const age = Number.isFinite(session.ageMs) ? `${formatElapsedMs(session.ageMs)} ago` : "unknown";
		lines.push(
			`- ${status} ${session.mode} pid:${session.pid}${session.current ? " this" : ""}${session.sessionName ? ` name:${session.sessionName}` : ""} updated:${age} idle:${session.idle === undefined ? "unknown" : session.idle ? "yes" : "no"} workflows:${session.activeWorkflowRuns ?? 0}`,
		);
		lines.push(`  session: ${session.sessionId ?? "unknown"}`);
		if (session.sessionFile) lines.push(`  file: ${session.sessionFile}`);
	}
	return lines.join("\n");
}

export interface SessionPruneEntry {
	file: string;
	record: unknown;
}

export interface SessionCleanupItem {
	file: string;
	action: "delete" | "keep";
	reason: string;
	id?: string;
	pid?: number;
}

// Política prune pura para `/workflow cleanup sessions`. Dado los on-disk live-session
// files (cada uno con su raw parsed record), decide cuáles son safe para borrar. `now` e
// isPidAlive se inyectan así esto es puro y offline. Safe por default:
//   - unparseable record        → keep (nunca borra lo que no podemos clasificar)
//   - the current session's file → keep, always (defensive: nunca borra el nuestro)
//   - pid exited                 → remove (definitively safe)
//   - pid alive + fresh (live)   → keep
//   - pid alive + stale heartbeat→ keep unless includeHeartbeatStale (a live pid may be paused)
export function classifySessionFilesForCleanup(
	entries: SessionPruneEntry[],
	opts: { now: number; isPidAlive: (pid: number) => boolean; currentId?: string; includeHeartbeatStale?: boolean },
): SessionCleanupItem[] {
	return entries.map((entry) => {
		const record = parsePiSessionRecord(entry.record);
		if (!record) return { file: entry.file, action: "keep", reason: "unparseable session record" };
		const base = { file: entry.file, id: record.id, pid: record.pid };
		if (opts.currentId && record.id === opts.currentId) return { ...base, action: "keep", reason: "current session" };
		if (!opts.isPidAlive(record.pid)) return { ...base, action: "delete", reason: "pid exited" };
		const updatedMs = Date.parse(record.updatedAt);
		const ageMs = Number.isFinite(updatedMs) ? Math.max(0, opts.now - updatedMs) : Number.POSITIVE_INFINITY;
		const fresh = ageMs <= PI_SESSION_STALE_MS;
		if (!fresh && opts.includeHeartbeatStale) return { ...base, action: "delete", reason: "heartbeat stale" };
		if (!fresh) return { ...base, action: "keep", reason: "heartbeat stale but pid is alive" };
		return { ...base, action: "keep", reason: "live session" };
	});
}

export function classifySessionFilesForPrune(
	entries: SessionPruneEntry[],
	opts: { now: number; isPidAlive: (pid: number) => boolean; currentId?: string; includeHeartbeatStale?: boolean },
): { remove: string[]; keep: string[] } {
	const items = classifySessionFilesForCleanup(entries, opts);
	return {
		remove: items.filter((item) => item.action === "delete").map((item) => item.file),
		keep: items.filter((item) => item.action === "keep").map((item) => item.file),
	};
}

// IO wrapper: enumera los live-session files de este proyecto, clasifícalos, y desvincula
// los removibles. Solo toca files para ctx.cwd (otros projects' sessions se dejan solos).
export async function prunePiSessionFiles(
	ctx: ExtensionContext,
	opts: { includeHeartbeatStale?: boolean; dryRun?: boolean } = {},
): Promise<{ removed: string[]; kept: number; items: SessionCleanupItem[] }> {
	const now = Date.now();
	const entries: SessionPruneEntry[] = [];
	const seen = new Set<string>();
	for (const root of getLiveSessionRoots(ctx)) {
		if (!existsSync(root)) continue;
		let dirents: import("node:fs").Dirent[];
		try {
			dirents = await fs.readdir(root, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const dirent of dirents) {
			if (!dirent.isFile() || !dirent.name.endsWith(".json")) continue;
			const file = path.join(root, dirent.name);
			if (seen.has(file)) continue;
			seen.add(file);
			const record = await readPiSessionRecord(file);
			// Skip records that clearly belong to another project cwd / non-persistent mode.
			if (record && (record.cwd !== ctx.cwd || !isPersistentPiSessionMode(record.mode))) continue;
			entries.push({ file, record });
		}
	}
	const items = classifySessionFilesForCleanup(entries, {
		now,
		isPidAlive,
		currentId: livePiSession?.id,
		includeHeartbeatStale: opts.includeHeartbeatStale,
	});
	const remove = items.filter((item) => item.action === "delete").map((item) => item.file);
	if (opts.dryRun) return { removed: [...remove], kept: entries.length - remove.length, items };
	const removed: string[] = [];
	for (const file of remove) {
		try {
			await fs.unlink(file);
			removed.push(file);
		} catch {
			// Already gone or lost a race — nothing to clean up.
		}
	}
	return { removed, kept: entries.length - removed.length, items };
}
