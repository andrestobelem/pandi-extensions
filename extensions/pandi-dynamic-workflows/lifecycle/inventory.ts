import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { CONFIG_DIR_NAME, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getRunState } from "../run-state.js";
import { listRuns } from "../tui/index.js";
import type { WorkflowRunRecord, WorkflowRunState } from "../types.js";
import { WORKFLOW_DRAFT_DIR } from "../workflow-resolve.js";
import { activeRunIds } from "./registry.js";

export type CleanupTarget = "sessions" | "runs" | "drafts" | "tmp";
export type CleanupAction = "delete" | "keep";

export interface CleanupInventoryItem {
	target: CleanupTarget;
	action: CleanupAction;
	path: string;
	reason: string;
	id?: string;
	state?: WorkflowRunState;
}

export interface CleanupFileEntry {
	name: string;
	path: string;
	mtimeMs: number;
	isFile: boolean;
	isDirectory: boolean;
	isSymbolicLink: boolean;
}

function ageMs(now: number, mtimeMs: number): number {
	return Number.isFinite(mtimeMs) ? Math.max(0, now - mtimeMs) : Number.POSITIVE_INFINITY;
}

function workflowStem(filePath: string): string | undefined {
	const ext = path.extname(filePath).toLowerCase();
	if (ext !== ".js" && ext !== ".mjs" && ext !== ".cjs") return undefined;
	return filePath.slice(0, -ext.length).replaceAll(path.sep, "/");
}

function referencedDraftNames(runs: WorkflowRunRecord[]): Set<string> {
	const out = new Set<string>();
	for (const run of runs) {
		const workflow = run.workflow.replaceAll("\\", "/").replace(/\.(js|mjs|cjs)$/i, "");
		out.add(workflow);
		if (workflow.startsWith("drafts/")) out.add(workflow.slice("drafts/".length));
		else out.add(`drafts/${workflow}`);
	}
	return out;
}

export function classifyRunCleanup(
	runs: WorkflowRunRecord[],
	opts: { keep?: number; states?: WorkflowRunState[]; activeIds: Set<string> },
): CleanupInventoryItem[] {
	const keep = Math.max(0, Math.floor(opts.keep ?? 0));
	const stateFilter = opts.states ? new Set(opts.states) : undefined;
	const retained = new Set<string>();
	const terminalCandidates = runs
		.filter((run) => {
			const state = getRunState(run);
			return state !== "running" && !opts.activeIds.has(run.runId) && (!stateFilter || stateFilter.has(state));
		})
		.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
	for (const run of terminalCandidates.slice(0, keep)) retained.add(run.runId);

	return runs.map((run) => {
		const state = getRunState(run);
		const base = { target: "runs" as const, path: run.runDir, id: run.runId, state };
		if (state === "running") return { ...base, action: "keep" as const, reason: "el run está corriendo" };
		if (opts.activeIds.has(run.runId))
			return { ...base, action: "keep" as const, reason: "el run está activo en este proceso" };
		if (stateFilter && !stateFilter.has(state))
			return { ...base, action: "keep" as const, reason: `state ${state} no seleccionado` };
		if (retained.has(run.runId))
			return { ...base, action: "keep" as const, reason: `dentro de la ventana de retención (keep=${keep})` };
		return { ...base, action: "delete" as const, reason: `terminal ${state} fuera de la ventana de retención` };
	});
}

export function classifyDraftCleanup(
	entries: CleanupFileEntry[],
	runs: WorkflowRunRecord[],
	opts: { now: number; olderThanMs: number },
): CleanupInventoryItem[] {
	const referenced = referencedDraftNames(runs);
	return entries.map((entry) => {
		const base = { target: "drafts" as const, path: entry.path, id: entry.name };
		if (entry.name === "INDEX.md")
			return {
				...base,
				action: "keep" as const,
				reason: "el índice de drafts se regenera; no es un draft de workflow",
			};
		if (entry.isSymbolicLink)
			return {
				...base,
				action: "keep" as const,
				reason: "el symlink en el directorio de drafts no es un draft de workflow",
			};
		if (!entry.isFile) return { ...base, action: "keep" as const, reason: "no es un archivo draft de workflow" };
		const stem = workflowStem(entry.name);
		if (!stem) return { ...base, action: "keep" as const, reason: "no es un archivo draft de workflow" };
		if (referenced.has(stem) || referenced.has(`drafts/${stem}`)) {
			return { ...base, action: "keep" as const, reason: "el draft está referenciado por un run" };
		}
		if (ageMs(opts.now, entry.mtimeMs) <= opts.olderThanMs) {
			return { ...base, action: "keep" as const, reason: "el draft es reciente" };
		}
		return { ...base, action: "delete" as const, reason: "draft viejo sin uso" };
	});
}

export function classifyTmpCleanup(
	entries: CleanupFileEntry[],
	opts: { now: number; olderThanMs: number },
): CleanupInventoryItem[] {
	return entries.map((entry) => {
		const base = { target: "tmp" as const, path: entry.path, id: entry.name };
		if (ageMs(opts.now, entry.mtimeMs) <= opts.olderThanMs) {
			return { ...base, action: "keep" as const, reason: "la entrada tmp es reciente" };
		}
		if (entry.isSymbolicLink) return { ...base, action: "delete" as const, reason: "symlink viejo en tmp" };
		if (entry.isFile) return { ...base, action: "delete" as const, reason: "archivo viejo en tmp" };
		if (entry.isDirectory) return { ...base, action: "delete" as const, reason: "directorio viejo en tmp" };
		return { ...base, action: "keep" as const, reason: "tipo de entrada tmp no soportado" };
	});
}

export function cleanupDeletePaths(items: CleanupInventoryItem[]): string[] {
	return items.filter((item) => item.action === "delete").map((item) => item.path);
}

async function listCleanupEntries(root: string, opts: { recursive: boolean }): Promise<CleanupFileEntry[]> {
	if (!existsSync(root)) return [];
	const out: CleanupFileEntry[] = [];
	async function walk(dir: string): Promise<void> {
		let entries: import("node:fs").Dirent[];
		try {
			entries = await fs.readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const full = path.join(dir, entry.name);
			let stat: import("node:fs").Stats;
			try {
				stat = await fs.lstat(full);
			} catch {
				continue;
			}
			const item = {
				name: path.relative(root, full).replaceAll(path.sep, "/"),
				path: full,
				mtimeMs: stat.mtimeMs,
				isFile: stat.isFile(),
				isDirectory: stat.isDirectory(),
				isSymbolicLink: stat.isSymbolicLink(),
			};
			out.push(item);
			if (opts.recursive && item.isDirectory && !item.isSymbolicLink) await walk(full);
		}
	}
	await walk(root);
	return out;
}

async function removeCleanupItems(items: CleanupInventoryItem[]): Promise<string[]> {
	const removed: string[] = [];
	for (const item of items) {
		if (item.action !== "delete") continue;
		try {
			await fs.rm(item.path, { recursive: true, force: false });
			removed.push(item.path);
		} catch {
			// Ya se fue o perdió una carrera: cleanup sigue siendo idempotente.
		}
	}
	return removed;
}

export async function inventoryWorkflowRuns(
	ctx: ExtensionContext,
	opts: { keep?: number; states?: WorkflowRunState[] } = {},
): Promise<CleanupInventoryItem[]> {
	return classifyRunCleanup(await listRuns(ctx), {
		keep: opts.keep,
		states: opts.states,
		activeIds: new Set(activeRunIds()),
	});
}

export async function cleanupWorkflowDrafts(
	ctx: ExtensionContext,
	opts: { olderThanMs: number; dryRun?: boolean },
): Promise<{ removed: string[]; kept: number; items: CleanupInventoryItem[] }> {
	const root = path.join(ctx.cwd, CONFIG_DIR_NAME, WORKFLOW_DRAFT_DIR);
	const items = classifyDraftCleanup(await listCleanupEntries(root, { recursive: true }), await listRuns(ctx), {
		now: Date.now(),
		olderThanMs: opts.olderThanMs,
	});
	const removed = opts.dryRun ? cleanupDeletePaths(items) : await removeCleanupItems(items);
	return { removed, kept: items.length - removed.length, items };
}

export async function cleanupWorkflowTmp(
	ctx: ExtensionContext,
	opts: { olderThanMs: number; dryRun?: boolean },
): Promise<{ removed: string[]; kept: number; items: CleanupInventoryItem[] }> {
	const root = path.join(ctx.cwd, CONFIG_DIR_NAME, "tmp");
	const items = classifyTmpCleanup(await listCleanupEntries(root, { recursive: false }), {
		now: Date.now(),
		olderThanMs: opts.olderThanMs,
	});
	const removed = opts.dryRun ? cleanupDeletePaths(items) : await removeCleanupItems(items);
	return { removed, kept: items.length - removed.length, items };
}

export function formatCleanupInventory(items: CleanupInventoryItem[]): string[] {
	return items.map((item) => {
		const subject = item.id ? `${item.id} (${item.path})` : item.path;
		return `  - ${item.target} ${item.action}: ${subject} — ${item.reason}`;
	});
}
