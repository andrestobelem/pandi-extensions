import * as crypto from "node:crypto";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

const PANDI_SESSION_DIR = "pandi-session";
const PANDI_SESSION_LIVE_DIR = "live";
export const PANDI_SESSION_HEARTBEAT_MS = 5_000;
export const PANDI_SESSION_STALE_MS = 20_000;

interface PandiSessionRecord {
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
}

export interface PandiSessionModel extends PandiSessionRecord {
	file: string;
	live: boolean;
	current: boolean;
	ageMs: number;
	staleReason?: string;
}

interface LivePandiSessionRuntime {
	id: string;
	ctx: ExtensionContext;
	file: string;
	startedAt: string;
	reason: string;
	generation: number;
	stopping: boolean;
	writeInFlight?: Promise<void>;
	timer?: NodeJS.Timeout;
}

export interface SessionPruneEntry {
	file: string;
	record: unknown;
}

export interface PandiSessionCleanupItem {
	file: string;
	action: "delete" | "keep";
	reason: string;
	id?: string;
	pid?: number;
}

let livePandiSession: LivePandiSessionRuntime | undefined;
let pandiSessionHeartbeatGeneration = 0;
let pandiSessionHeartbeatWriteHookForTests: ((generation: number) => Promise<void>) | undefined;

export function setPandiSessionHeartbeatWriteHookForTests(hook?: (generation: number) => Promise<void>): void {
	pandiSessionHeartbeatWriteHookForTests = hook;
}

function projectHash(cwd: string): string {
	return crypto.createHash("sha256").update(path.resolve(cwd)).digest("hex").slice(0, 16);
}

async function ensureDir(dir: string): Promise<void> {
	await fs.mkdir(dir, { recursive: true });
}

async function writeJsonFile(file: string, value: unknown): Promise<void> {
	await ensureDir(path.dirname(file));
	await fs.writeFile(file, `${JSON.stringify(value, null, "\t")}\n`, "utf8");
}

function getLiveSessionRoot(ctx: ExtensionContext): string {
	if (ctx.isProjectTrusted()) return path.join(ctx.cwd, CONFIG_DIR_NAME, PANDI_SESSION_DIR, PANDI_SESSION_LIVE_DIR);
	return path.join(getAgentDir(), PANDI_SESSION_DIR, PANDI_SESSION_LIVE_DIR, projectHash(ctx.cwd));
}

function getLiveSessionRoots(ctx: ExtensionContext): string[] {
	const roots = [path.join(getAgentDir(), PANDI_SESSION_DIR, PANDI_SESSION_LIVE_DIR, projectHash(ctx.cwd))];
	if (ctx.isProjectTrusted())
		roots.unshift(path.join(ctx.cwd, CONFIG_DIR_NAME, PANDI_SESSION_DIR, PANDI_SESSION_LIVE_DIR));
	return [...new Set(roots)];
}

function isPersistentSessionMode(mode: string): boolean {
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

function buildPandiSessionRecord(runtime: LivePandiSessionRuntime): PandiSessionRecord {
	const { ctx } = runtime;
	return {
		id: runtime.id,
		pid: process.pid,
		mode: ctx.mode,
		cwd: ctx.cwd,
		startedAt: runtime.startedAt,
		updatedAt: new Date().toISOString(),
		reason: runtime.reason,
		...sessionManagerMetadata(ctx),
		trusted: ctx.isProjectTrusted(),
		idle: ctx.isIdle(),
	};
}

async function writePandiSessionHeartbeat(runtime: LivePandiSessionRuntime): Promise<void> {
	if (runtime.stopping || livePandiSession?.generation !== runtime.generation) return;
	if (runtime.writeInFlight) return runtime.writeInFlight;
	const write = (async () => {
		try {
			await pandiSessionHeartbeatWriteHookForTests?.(runtime.generation);
			if (runtime.stopping || livePandiSession?.generation !== runtime.generation) return;
			await writeJsonFile(runtime.file, buildPandiSessionRecord(runtime));
		} catch {
			// Mejor esfuerzo: un dashboard no debería fallar porque el registro de sesiones vivas
			// no se pueda escribir (permisos, directorios temporales borrados o carreras de recarga).
		}
	})();
	runtime.writeInFlight = write;
	await write;
	if (runtime.writeInFlight === write) runtime.writeInFlight = undefined;
}

export async function startPandiSessionHeartbeat(event: { reason: string }, ctx: ExtensionContext): Promise<void> {
	await stopPandiSessionHeartbeat();
	if (!isPersistentSessionMode(ctx.mode)) return;
	const id = `${Date.now().toString(36)}-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
	const runtime: LivePandiSessionRuntime = {
		id,
		ctx,
		file: path.join(getLiveSessionRoot(ctx), `${id}.json`),
		startedAt: new Date().toISOString(),
		reason: event.reason,
		generation: ++pandiSessionHeartbeatGeneration,
		stopping: false,
	};
	livePandiSession = runtime;
	await writePandiSessionHeartbeat(runtime);
	if (runtime.stopping || livePandiSession?.generation !== runtime.generation) return;
	runtime.timer = setInterval(() => void writePandiSessionHeartbeat(runtime), PANDI_SESSION_HEARTBEAT_MS);
	runtime.timer.unref?.();
}

export async function stopPandiSessionHeartbeat(): Promise<void> {
	const runtime = livePandiSession;
	if (!runtime) return;
	runtime.stopping = true;
	livePandiSession = undefined;
	if (runtime.timer) clearInterval(runtime.timer);
	await runtime.writeInFlight;
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

function parsePandiSessionRecord(value: unknown): PandiSessionRecord | undefined {
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
	};
}

async function readPandiSessionRecord(file: string): Promise<PandiSessionRecord | undefined> {
	try {
		return parsePandiSessionRecord(JSON.parse(await fs.readFile(file, "utf8")));
	} catch {
		return undefined;
	}
}

export async function collectPandiSessions(ctx: ExtensionContext): Promise<PandiSessionModel[]> {
	const now = Date.now();
	const byId = new Map<string, PandiSessionModel>();
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
			const record = await readPandiSessionRecord(file);
			if (record?.cwd !== ctx.cwd || !isPersistentSessionMode(record.mode)) continue;
			const updatedMs = Date.parse(record.updatedAt);
			const ageMs = Number.isFinite(updatedMs) ? Math.max(0, now - updatedMs) : Number.POSITIVE_INFINITY;
			const pidAlive = isPidAlive(record.pid);
			const fresh = Number.isFinite(ageMs) && ageMs <= PANDI_SESSION_STALE_MS;
			const live = pidAlive && fresh;
			const staleReason = live
				? undefined
				: !pidAlive
					? "PID finalizado"
					: !fresh
						? "heartbeat obsoleto"
						: "desconocido";
			const model: PandiSessionModel = {
				...record,
				file,
				live,
				current: record.id === livePandiSession?.id,
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

function formatElapsedMs(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const remainder = seconds % 60;
	if (minutes < 60) return `${minutes}m${remainder.toString().padStart(2, "0")}s`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h${(minutes % 60).toString().padStart(2, "0")}m`;
}

function formatPandiSessionLines(session: PandiSessionModel): string[] {
	const status = session.live ? "live" : `stale${session.staleReason ? `:${session.staleReason}` : ""}`;
	const age = Number.isFinite(session.ageMs) ? `hace ${formatElapsedMs(session.ageMs)}` : "desconocido";
	const lines = [
		`- ${status} ${session.mode} pid:${session.pid}${session.current ? " actual" : ""}${session.sessionName ? ` nombre:${session.sessionName}` : ""} actualizado:${age} inactivo:${session.idle === undefined ? "desconocido" : session.idle ? "sí" : "no"}`,
		`  sesión: ${session.sessionId ?? "desconocida"}`,
	];
	if (session.sessionFile) lines.push(`  archivo: ${session.sessionFile}`);
	return lines;
}

export function formatPandiSessionList(sessions: PandiSessionModel[]): string {
	const lines = [`Sesiones Pandi (${sessions.length})`];
	if (sessions.length === 0) {
		lines.push("No se encontraron sesiones TUI/RPC vivas de Pandi para este proyecto.");
		return lines.join("\n");
	}
	for (const session of sessions) {
		lines.push(...formatPandiSessionLines(session));
	}
	return lines.join("\n");
}

export function classifyPandiSessionFilesForCleanup(
	entries: SessionPruneEntry[],
	opts: { now: number; isPidAlive: (pid: number) => boolean; currentId?: string; includeHeartbeatStale?: boolean },
): PandiSessionCleanupItem[] {
	return entries.map((entry) => {
		const record = parsePandiSessionRecord(entry.record);
		if (!record) return { file: entry.file, action: "keep", reason: "registro de sesión ilegible" };
		const base = { file: entry.file, id: record.id, pid: record.pid };
		if (opts.currentId && record.id === opts.currentId) return { ...base, action: "keep", reason: "sesión actual" };
		if (!opts.isPidAlive(record.pid)) return { ...base, action: "delete", reason: "PID finalizado" };
		const updatedMs = Date.parse(record.updatedAt);
		const ageMs = Number.isFinite(updatedMs) ? Math.max(0, opts.now - updatedMs) : Number.POSITIVE_INFINITY;
		const fresh = ageMs <= PANDI_SESSION_STALE_MS;
		if (!fresh && opts.includeHeartbeatStale) return { ...base, action: "delete", reason: "heartbeat obsoleto" };
		if (!fresh) return { ...base, action: "keep", reason: "heartbeat obsoleto pero el PID sigue vivo" };
		return { ...base, action: "keep", reason: "sesión viva" };
	});
}

export function classifyPandiSessionFilesForPrune(
	entries: SessionPruneEntry[],
	opts: { now: number; isPidAlive: (pid: number) => boolean; currentId?: string; includeHeartbeatStale?: boolean },
): { remove: string[]; keep: string[] } {
	const items = classifyPandiSessionFilesForCleanup(entries, opts);
	return {
		remove: items.filter((item) => item.action === "delete").map((item) => item.file),
		keep: items.filter((item) => item.action === "keep").map((item) => item.file),
	};
}

export async function prunePandiSessionFiles(
	ctx: ExtensionContext,
	opts: { includeHeartbeatStale?: boolean; dryRun?: boolean } = {},
): Promise<{ removed: string[]; kept: number; items: PandiSessionCleanupItem[] }> {
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
			const record = await readPandiSessionRecord(file);
			if (record && (record.cwd !== ctx.cwd || !isPersistentSessionMode(record.mode))) continue;
			entries.push({ file, record });
		}
	}
	const items = classifyPandiSessionFilesForCleanup(entries, {
		now,
		isPidAlive,
		currentId: livePandiSession?.id,
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
			// Ya no existía o se perdió la carrera.
		}
	}
	return { removed, kept: entries.length - removed.length, items };
}
