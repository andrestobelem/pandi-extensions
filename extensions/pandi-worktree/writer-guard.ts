/**
 * Guard de un solo escritor para un worktree de git.
 *
 * El guard es intencionalmente conservador: la primera acción mutante de Pi en
 * un worktree toma un lease con heartbeat corto bajo .pi/. Una segunda sesión
 * activa de Pi en el mismo worktree queda bloqueada antes de que puedan correr
 * tools mutantes internas (o bash directo del usuario). Las acciones de solo
 * lectura y el escape `/worktree open` siguen disponibles para continuar en un
 * worktree aparte.
 */

import { randomUUID } from "node:crypto";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import {
	CONFIG_DIR_NAME,
	type ExtensionAPI,
	type ExtensionContext,
	type ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import { DEFAULT_GIT_TIMEOUT_MS as GIT_TIMEOUT_MS, runGit } from "./worktree.js";

const WRITER_LEASE_FILE = "worktree-writer.json";
const WRITER_GUARD_ENV = "PI_WORKTREE_WRITER_GUARD";
const HEARTBEAT_INTERVAL_MS = 15_000;
const STALE_LEASE_MS = 2 * 60_000;
const LOCK_STALE_MS = 10_000;
const LOCK_RETRY_DEADLINE_MS = 250;
const LOCK_RETRY_DELAY_MS = 25;
const TRUE_TOKENS = new Set(["1", "true", "on", "yes"]);

interface WriterLease {
	version: 1;
	id: string;
	pid: number;
	mode: string;
	cwd: string;
	worktreeRoot: string;
	sessionId?: string;
	sessionName?: string;
	sessionFile?: string;
	startedAt: string;
	updatedAt: string;
	lastTool?: string;
	lastCommand?: string;
}

interface GuardState {
	id: string;
	leasePath?: string;
	worktreeRoot?: string;
	heartbeat?: NodeJS.Timeout;
	lastLease?: WriterLease;
}

interface LeaseDecision {
	allowed: boolean;
	worktreeRoot?: string;
	reason?: string;
}

interface SessionIdentity {
	sessionId?: string;
	sessionName?: string;
	sessionFile?: string;
}

interface MutationIntent {
	kind: "tool" | "user_bash" | "command";
	toolName?: string;
	command?: string;
}

let activeGuardState: GuardState | undefined;
let sessionWriterGuardEnabled: boolean | undefined;

export function registerWorktreeWriterGuard(pi: ExtensionAPI): void {
	const state: GuardState = { id: randomUUID() };
	activeGuardState = state;

	pi.on("session_shutdown", async () => {
		await releaseWriterLease(state);
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!isWorktreeWriterGuardEnabled()) return undefined;
		const intent = mutationIntentForToolCall(event);
		if (!intent) return undefined;
		const decision = await ensureWriterLease(state, ctx, intent);
		if (decision.allowed) return undefined;
		notifyConflict(ctx, decision.reason ?? "Otro writer activo bloquea esta acción.");
		return { block: true, reason: decision.reason };
	});

	pi.on("user_bash", async (event, ctx) => {
		if (!isWorktreeWriterGuardEnabled()) return undefined;
		if (!isMutatingBashCommand(event.command)) return undefined;
		const decision = await ensureWriterLease(state, ctx, {
			kind: "user_bash",
			toolName: "user_bash",
			command: event.command,
		});
		if (decision.allowed) return undefined;
		const output = decision.reason ?? "Otro writer activo bloquea este comando.";
		notifyConflict(ctx, output);
		return {
			result: {
				output,
				exitCode: 1,
				cancelled: false,
				truncated: false,
			},
		};
	});
}

export async function ensureWorktreeWriterForCommand(
	ctx: ExtensionContext,
	intent: { action: string; command: string; dryRun?: boolean },
): Promise<LeaseDecision> {
	// Los slash commands se invocan en proceso, así que necesitan un guard
	// explícito solo cuando el guard opcional está activado. Mantené list/set/help
	// como solo lectura, prune --dry-run también, y add/open como salida
	// documentada para mover el trabajo a otro worktree.
	if (!isWorktreeWriterGuardEnabled() || !isGuardedWorktreeCommand(intent.action, intent.dryRun)) {
		return { allowed: true };
	}
	const state: GuardState = getCommandGuardState();
	return ensureWriterLease(state, ctx, { kind: "command", toolName: "/worktree", command: intent.command });
}

export function isWorktreeWriterGuardEnabled(): boolean {
	return sessionWriterGuardEnabled ?? TRUE_TOKENS.has((process.env[WRITER_GUARD_ENV] ?? "").trim().toLowerCase());
}

export async function setWorktreeWriterGuardEnabled(enabled: boolean): Promise<void> {
	sessionWriterGuardEnabled = enabled;
	if (!enabled) {
		await releaseWriterLease(activeGuardState ?? commandGuardState ?? { id: "" });
	}
}

export function resetWorktreeWriterGuardSessionDefault(): void {
	sessionWriterGuardEnabled = undefined;
}

export function formatWorktreeWriterBlock(reason: string | undefined): string {
	return reason ?? "Otro writer activo bloquea esta acción.";
}

let commandGuardState: GuardState | undefined;
function getCommandGuardState(): GuardState {
	if (activeGuardState) return activeGuardState;
	commandGuardState ??= { id: randomUUID() };
	return commandGuardState;
}

function isGuardedWorktreeCommand(action: string, dryRun?: boolean): boolean {
	return action === "remove" || (action === "prune" && !dryRun);
}

function mutationIntentForToolCall(event: ToolCallEvent): MutationIntent | undefined {
	if (event.toolName === "write" || event.toolName === "edit") {
		return { kind: "tool", toolName: event.toolName };
	}
	if (event.toolName === "bash") {
		const command = typeof event.input.command === "string" ? event.input.command : "";
		return isMutatingBashCommand(command) ? { kind: "tool", toolName: "bash", command } : undefined;
	}
	if (event.toolName === "git_worktree") {
		const action = typeof event.input.action === "string" ? event.input.action : "";
		const dryRun = event.input.dryRun === true;
		return action === "remove" || (action === "prune" && !dryRun)
			? { kind: "tool", toolName: "git_worktree" }
			: undefined;
	}
	if (event.toolName === "dynamic_workflow") {
		const action = typeof event.input.action === "string" ? event.input.action : "";
		const mutating = new Set(["write", "run", "start", "resume", "cancel", "delete", "report"]);
		return mutating.has(action) ? { kind: "tool", toolName: "dynamic_workflow" } : undefined;
	}
	if (event.toolName === "markdown_to_html" || event.toolName === "remember" || event.toolName === "goal_progress") {
		return { kind: "tool", toolName: event.toolName };
	}
	return undefined;
}

function isMutatingBashCommand(command: string): boolean {
	const parsed = splitShellCommands(command);
	if (!parsed.ok) return true;
	if (parsed.hasWriteRedirection) return true;
	return parsed.parts.length === 0 ? false : !parsed.parts.every(isReadOnlySimpleCommand);
}

interface SplitShellCommandsResult {
	ok: boolean;
	parts: string[];
	hasWriteRedirection: boolean;
}

function splitShellCommands(command: string): SplitShellCommandsResult {
	const parts: string[] = [];
	let current = "";
	let quote: "'" | '"' | undefined;
	let escaped = false;
	let hasWriteRedirection = false;
	const push = (): void => {
		const part = current.trim();
		if (part) parts.push(part);
		current = "";
	};
	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		const next = command[i + 1];
		if (escaped) {
			current += ch;
			escaped = false;
			continue;
		}
		if (ch === "\\") {
			current += ch;
			escaped = true;
			continue;
		}
		if (quote) {
			current += ch;
			if (ch === quote) quote = undefined;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			current += ch;
			continue;
		}
		if (ch === ">" && next !== ">") {
			hasWriteRedirection = true;
			current += ch;
			continue;
		}
		if (ch === ">" && next === ">") {
			hasWriteRedirection = true;
			current += ch;
			current += next;
			i++;
			continue;
		}
		if (ch === "<" && next === "<") {
			hasWriteRedirection = true;
			current += ch;
			current += next;
			i++;
			continue;
		}
		if (ch === "\n" || ch === ";") {
			push();
			continue;
		}
		if (ch === "&" && next === "&") {
			push();
			i++;
			continue;
		}
		if (ch === "|" && next === "|") {
			push();
			i++;
			continue;
		}
		if (ch === "|") {
			push();
			continue;
		}
		current += ch;
	}
	if (quote || escaped) return { ok: false, parts, hasWriteRedirection };
	push();
	return { ok: true, parts, hasWriteRedirection };
}

function isReadOnlyFindCommand(command: string): boolean {
	if (!/^find\b/.test(command)) return false;
	return !/(^|\s)-(delete|exec|execdir|ok|okdir|fprint|fprint0|fls|fprintf)\b/.test(command);
}

function isReadOnlySedCommand(command: string): boolean {
	if (!/^sed\s+-n\b/.test(command)) return false;
	return !/(^|\s)(--in-place(?:=|\b)|-[A-Za-z]*i[A-Za-z]*\b)/.test(command);
}

function isReadOnlySimpleCommand(command: string): boolean {
	const c = command.trim();
	if (!c) return true;
	if (/^(pwd|printf|ls|ll|la|rg|grep|cat|head|tail|wc)\b/.test(c)) return true;
	if (isReadOnlyFindCommand(c)) return true;
	if (isReadOnlySedCommand(c)) return true;
	if (/^git\s+(status|diff|log|show|rev-parse|ls-files)\b/.test(c)) return true;
	if (/^git\s+branch\s+(--show-current|-vv?)(\s|$)/.test(c)) return true;
	if (/^git\s+worktree\s+list\b/.test(c)) return true;
	if (/^git\s+remote\s+(-v|show\b)/.test(c)) return true;
	if (/^git\s+config\s+(--get|--list)\b/.test(c)) return true;
	return false;
}

async function ensureWriterLease(
	state: GuardState,
	ctx: ExtensionContext,
	intent: MutationIntent,
): Promise<LeaseDecision> {
	const worktreeRoot = await resolveGitWorktreeRoot(ctx.cwd, ctx.signal);
	if (!worktreeRoot) return { allowed: true };
	const leasePath = path.join(worktreeRoot, CONFIG_DIR_NAME, WRITER_LEASE_FILE);
	return withLeaseLock(leasePath, async () => {
		const existing = await readLease(leasePath);
		if (existing && !isSelfLease(existing, state, ctx) && !isStaleLease(existing)) {
			return {
				allowed: false,
				worktreeRoot,
				reason: conflictReason(existing, worktreeRoot, intent),
			};
		}
		const lease = buildLease(state, ctx, worktreeRoot, intent, existing);
		await writeLease(leasePath, lease);
		state.leasePath = leasePath;
		state.worktreeRoot = worktreeRoot;
		state.lastLease = lease;
		startHeartbeat(state, ctx, intent);
		return { allowed: true, worktreeRoot };
	});
}

async function resolveGitWorktreeRoot(cwd: string, signal?: AbortSignal): Promise<string | undefined> {
	const result = await runGit(["rev-parse", "--show-toplevel"], { cwd, signal, timeoutMs: GIT_TIMEOUT_MS });
	if (!result.ok) return undefined;
	const root = result.stdout.trim().split("\n")[0];
	return root ? path.resolve(cwd, root) : undefined;
}

async function withLeaseLock(leasePath: string, fn: () => Promise<LeaseDecision>): Promise<LeaseDecision> {
	const lockPath = `${leasePath}.lock`;
	await fsp.mkdir(path.dirname(leasePath), { recursive: true });
	const deadline = Date.now() + LOCK_RETRY_DEADLINE_MS;
	let handle: fsp.FileHandle | undefined;
	while (!handle) {
		try {
			handle = await fsp.open(lockPath, "wx");
			await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
			break;
		} catch (err) {
			if (!isNodeErrno(err, "EEXIST")) {
				return {
					allowed: false,
					reason: `No se pudo tomar el bloqueo de escritura del worktree: ${errorMessage(err)}`,
				};
			}
			if (await removeStaleLock(lockPath)) continue;
			if (Date.now() >= deadline) {
				return {
					allowed: false,
					reason: `El bloqueo de escritura del worktree está ocupado; reintentá en unos segundos o seguí en otro worktree con /worktree open <nombre>.`,
				};
			}
			await sleep(LOCK_RETRY_DELAY_MS);
		}
	}
	try {
		return await fn();
	} finally {
		await handle?.close().catch(() => undefined);
		await fsp.unlink(lockPath).catch(() => undefined);
	}
}

async function removeStaleLock(lockPath: string): Promise<boolean> {
	try {
		const stat = await fsp.stat(lockPath);
		if (Date.now() - stat.mtimeMs < LOCK_STALE_MS) return false;
		await fsp.unlink(lockPath);
		return true;
	} catch {
		return false;
	}
}

async function readLease(leasePath: string): Promise<WriterLease | undefined> {
	try {
		const parsed = JSON.parse(await fsp.readFile(leasePath, "utf8"));
		if (parsed && typeof parsed === "object" && typeof parsed.id === "string") return parsed as WriterLease;
		return undefined;
	} catch (err) {
		if (isNodeErrno(err, "ENOENT")) return undefined;
		return undefined;
	}
}

function buildLease(
	state: GuardState,
	ctx: ExtensionContext,
	worktreeRoot: string,
	intent: MutationIntent,
	existing?: WriterLease,
): WriterLease {
	const now = new Date().toISOString();
	const identity = sessionIdentity(ctx);
	return {
		version: 1,
		id: state.id,
		pid: process.pid,
		mode: ctx.mode,
		cwd: ctx.cwd,
		worktreeRoot,
		...identity,
		startedAt: existing && isSelfLease(existing, state, ctx) ? existing.startedAt : now,
		updatedAt: now,
		lastTool: intent.toolName,
		lastCommand: intent.command,
	};
}

async function writeLease(leasePath: string, lease: WriterLease): Promise<void> {
	await fsp.mkdir(path.dirname(leasePath), { recursive: true });
	const tmp = `${leasePath}.${process.pid}.${randomUUID()}.tmp`;
	await fsp.writeFile(tmp, `${JSON.stringify(lease, null, 2)}\n`, "utf8");
	await fsp.rename(tmp, leasePath);
}

async function releaseWriterLease(state: GuardState): Promise<void> {
	if (state.heartbeat) clearInterval(state.heartbeat);
	state.heartbeat = undefined;
	const leasePath = state.leasePath;
	if (!leasePath) return;
	await withLeaseLock(leasePath, async () => {
		const existing = await readLease(leasePath);
		if (existing && existing.id === state.id) await fsp.unlink(leasePath).catch(() => undefined);
		return { allowed: true };
	});
	state.leasePath = undefined;
	state.worktreeRoot = undefined;
	state.lastLease = undefined;
}

function startHeartbeat(state: GuardState, ctx: ExtensionContext, intent: MutationIntent): void {
	if (state.heartbeat) return;
	state.heartbeat = setInterval(() => {
		void heartbeat(state, ctx, intent);
	}, HEARTBEAT_INTERVAL_MS);
	if (typeof state.heartbeat.unref === "function") state.heartbeat.unref();
}

async function heartbeat(state: GuardState, ctx: ExtensionContext, intent: MutationIntent): Promise<void> {
	if (!state.leasePath || !state.worktreeRoot) return;
	await withLeaseLock(state.leasePath, async () => {
		const existing = await readLease(state.leasePath ?? "");
		if (!existing || existing.id !== state.id) return { allowed: true };
		const lease = buildLease(state, ctx, state.worktreeRoot ?? ctx.cwd, intent, existing);
		await writeLease(state.leasePath ?? "", lease);
		state.lastLease = lease;
		return { allowed: true };
	}).catch(() => undefined);
}

function isSelfLease(lease: WriterLease, state: GuardState, ctx: ExtensionContext): boolean {
	if (lease.id === state.id) return true;
	const current = sessionIdentity(ctx);
	if (current.sessionId && lease.sessionId === current.sessionId) return true;
	if (current.sessionFile && lease.sessionFile === current.sessionFile) return true;
	return false;
}

function isStaleLease(lease: WriterLease): boolean {
	const ts = Date.parse(lease.updatedAt);
	if (!Number.isFinite(ts)) return true;
	return Date.now() - ts > STALE_LEASE_MS;
}

function sessionIdentity(ctx: ExtensionContext): SessionIdentity {
	return {
		sessionId: safeCall(() => ctx.sessionManager.getSessionId()),
		sessionName: safeCall(() => ctx.sessionManager.getSessionName()),
		sessionFile: safeCall(() => ctx.sessionManager.getSessionFile()),
	};
}

function conflictReason(lease: WriterLease, worktreeRoot: string, intent: MutationIntent): string {
	const owner = lease.sessionName || lease.sessionId || lease.id;
	const updated = lease.updatedAt ? ` último latido ${lease.updatedAt}` : "";
	const action = intent.command ? `comando: ${intent.command}` : `tool: ${intent.toolName ?? intent.kind}`;
	return [
		`Guard de un solo escritor: este worktree ya tiene un escritor activo (${owner}, pid ${lease.pid};${updated}).`,
		`Worktree: ${worktreeRoot}`,
		`Acción bloqueada: ${action}`,
		'Para seguir sin contaminar cambios/tests/commits, abrí una sesión Pi en otro worktree: /worktree open <nombre> (o pedime usar git_worktree con action="open").',
	].join("\n");
}

function notifyConflict(ctx: ExtensionContext, reason: string): void {
	if (ctx.hasUI) ctx.ui.notify(reason, "warning");
}

function safeCall<T>(fn: () => T): T | undefined {
	try {
		return fn();
	} catch {
		return undefined;
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function isNodeErrno(err: unknown, code: string): boolean {
	return typeof err === "object" && err !== null && "code" in err && (err as { code?: unknown }).code === code;
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

// Exported for targeted tests and future guard tuning.
export const __writerGuardForTests = {
	isMutatingBashCommand,
	isReadOnlySimpleCommand,
	isWorktreeWriterGuardEnabled,
	resetWorktreeWriterGuardSessionDefault,
	setWorktreeWriterGuardEnabled,
	splitShellCommands,
};
