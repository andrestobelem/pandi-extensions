/**
 * Resolución de workflows — descubrimiento de archivos de workflow entre ubicaciones project/global y el
 * layout de filesystem para runs y graphs (slugify, projectHash, roots de run/graph, listWorkflows,
 * resolveWorkflow, createRunDirectory). La incumbencia "dónde viven los workflows y adónde van sus runs/
 * graphs", separada del engine que los ejecuta.
 *
 * Los segmentos de path canónicos viven acá para que el engine importe el layout desde una hoja de resolución,
 * no al revés. Los tipos record/scope cruzan como import type. Extraído byte-idéntico.
 */

import * as crypto from "node:crypto";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_DIR_NAME, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { resolveInsideRoot } from "./path-safety.js";
import type {
	WorkflowDefinition,
	WorkflowLocation,
	WorkflowRunRecord,
	WorkflowScope,
	WorkflowScopeInput,
} from "./types.js";

export const WORKFLOW_DIR = "workflows";
export const WORKFLOW_DRAFT_DIR = path.join(WORKFLOW_DIR, "drafts");
export const WORKFLOW_RUN_DIR = path.join(WORKFLOW_DIR, "runs");
export const WORKFLOW_GRAPH_DIR = path.join(WORKFLOW_DIR, "graphs");

const RESERVED_WORKFLOW_SUBDIRS = new Set(["drafts", "runs", "graphs", "sessions"]);
// Pi packages no declaran workflows como recurso nativo. Este directorio sibling viaja con la
// extensión y participa como fallback global, sin copiar ni mutar el agent-dir del usuario.
const BUNDLED_WORKFLOW_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "workflows");

export function slugify(value: string): string {
	const slug = value
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 80);
	return slug || "workflow";
}

function normalizeWorkflowName(input: string): string {
	const raw = input.trim().replaceAll("\\", "/");
	if (!raw) throw new Error("Workflow name is required.");
	if (path.isAbsolute(raw)) throw new Error("Workflow name must be relative, not absolute.");
	if (raw.split("/").some((part) => part === "..")) throw new Error("Workflow name must not contain '..'.");
	if (!/^[a-zA-Z0-9._/-]+$/.test(raw)) {
		throw new Error("Workflow name may only contain letters, numbers, '.', '_', '-', and '/'.");
	}
	if (/\.(js|mjs|cjs)$/i.test(raw)) return raw;
	return `${raw}.js`;
}

function workflowDisplayName(relativePath: string): string {
	return relativePath.replace(/\.(js|mjs|cjs)$/i, "");
}

function getLocations(ctx: ExtensionContext): WorkflowLocation[] {
	return [
		{
			scope: "project",
			root: path.join(ctx.cwd, CONFIG_DIR_NAME, WORKFLOW_DRAFT_DIR),
			trusted: ctx.isProjectTrusted(),
			kind: "draft",
		},
		{
			scope: "project",
			root: path.join(ctx.cwd, CONFIG_DIR_NAME, WORKFLOW_DIR),
			trusted: ctx.isProjectTrusted(),
			kind: "workflow",
		},
		{
			scope: "global",
			root: path.join(getAgentDir(), WORKFLOW_DRAFT_DIR),
			trusted: true,
			kind: "draft",
		},
		{
			scope: "global",
			root: path.join(getAgentDir(), WORKFLOW_DIR),
			trusted: true,
			kind: "workflow",
		},
		{
			scope: "global",
			root: BUNDLED_WORKFLOW_DIR,
			trusted: true,
			kind: "workflow",
			readOnly: true,
		},
	];
}

export function projectHash(cwd: string): string {
	return crypto.createHash("sha1").update(cwd).digest("hex").slice(0, 12);
}

function getGlobalRunRoot(ctx: ExtensionContext): string {
	return path.join(getAgentDir(), WORKFLOW_RUN_DIR, projectHash(ctx.cwd));
}

function getRunRoot(ctx: ExtensionContext): string {
	if (ctx.isProjectTrusted()) return path.join(ctx.cwd, CONFIG_DIR_NAME, WORKFLOW_RUN_DIR);
	return getGlobalRunRoot(ctx);
}

export function getRunRoots(ctx: ExtensionContext): string[] {
	const roots = [getRunRoot(ctx), getGlobalRunRoot(ctx)];
	return [...new Set(roots)];
}

export function getGraphRoot(ctx: ExtensionContext): string {
	if (ctx.isProjectTrusted()) return path.join(ctx.cwd, CONFIG_DIR_NAME, WORKFLOW_GRAPH_DIR);
	return path.join(getAgentDir(), WORKFLOW_GRAPH_DIR, projectHash(ctx.cwd));
}

function requireTrustedProject(ctx: ExtensionContext): void {
	if (!ctx.isProjectTrusted()) {
		throw new Error(`Project workflows require a trusted project. Run /trust or use scope=global.`);
	}
}

export async function ensureDir(dir: string): Promise<void> {
	await fs.mkdir(dir, { recursive: true });
}

async function walkWorkflowFiles(
	root: string,
	options: { skipReservedTopLevelDirs?: boolean } = {},
): Promise<string[]> {
	if (!existsSync(root)) return [];
	const out: string[] = [];
	async function walk(dir: string): Promise<void> {
		const entries = await fs.readdir(dir, { withFileTypes: true });
		for (const entry of entries) {
			if (options.skipReservedTopLevelDirs && dir === root && RESERVED_WORKFLOW_SUBDIRS.has(entry.name)) continue;
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				await walk(full);
				continue;
			}
			if (entry.isFile() && /\.(js|mjs|cjs)$/i.test(entry.name)) {
				out.push(full);
			}
		}
	}
	await walk(root);
	return out.sort();
}

export async function listWorkflows(ctx: ExtensionContext): Promise<WorkflowDefinition[]> {
	const files: WorkflowDefinition[] = [];
	for (const location of getLocations(ctx)) {
		if (!location.trusted) continue;
		for (const file of await walkWorkflowFiles(location.root, {
			skipReservedTopLevelDirs: location.kind === "workflow",
		})) {
			const relativePath = path.relative(location.root, file).replaceAll(path.sep, "/");
			files.push({
				name: workflowDisplayName(relativePath),
				scope: location.scope,
				path: file,
				relativePath,
				...(location.readOnly ? { readOnly: true } : {}),
			});
		}
	}
	return files;
}

export async function resolveWorkflow(
	ctx: ExtensionContext,
	name: string,
	scope: WorkflowScopeInput = "auto",
	forWrite: false | "draft" | "workflow" = false,
): Promise<WorkflowDefinition> {
	const relativePath = normalizeWorkflowName(name);
	const locations = getLocations(ctx);

	if (forWrite) {
		const targetScope: WorkflowScope = scope === "global" ? "global" : "project";
		if (targetScope === "project") requireTrustedProject(ctx);
		const targetKind: WorkflowLocation["kind"] = forWrite;
		const location = locations.find((loc) => loc.scope === targetScope && loc.kind === targetKind && !loc.readOnly)!;
		await ensureDir(location.root);
		const file = resolveInsideRoot(
			location.root,
			path.join(location.root, relativePath),
			relativePath,
			"workflow directory",
		);
		return {
			name: workflowDisplayName(relativePath),
			scope: targetScope,
			path: file,
			relativePath,
		};
	}

	const candidates = scope === "auto" ? locations : locations.filter((loc) => loc.scope === scope);
	for (const location of candidates) {
		if (!location.trusted) continue;
		const file = path.join(location.root, relativePath);
		if (existsSync(file)) {
			const safeFile = resolveInsideRoot(location.root, file, relativePath, "workflow directory");
			return {
				name: workflowDisplayName(relativePath),
				scope: location.scope,
				path: safeFile,
				relativePath,
				...(location.readOnly ? { readOnly: true } : {}),
			};
		}
	}

	if (scope === "project" && !ctx.isProjectTrusted()) requireTrustedProject(ctx);
	throw new Error(`Workflow not found: ${name}`);
}

export async function resolveWorkflowForRun(
	ctx: ExtensionContext,
	run: WorkflowRunRecord,
): Promise<WorkflowDefinition | undefined> {
	try {
		return await resolveWorkflow(ctx, run.workflow, run.scope);
	} catch {
		if (run.file && existsSync(run.file)) {
			return {
				name: run.workflow,
				scope: run.scope,
				path: run.file,
				relativePath: path.basename(run.file),
			};
		}
		return undefined;
	}
}

export function parsePatternFlag(raw: string | undefined): string | undefined {
	const value = raw?.trim();
	if (!value) return undefined;
	const match =
		/(?:^|\s)--pattern(?:=|\s+)([^\s]+)/.exec(value) ?? /(?:^|\s)--from-pattern(?:=|\s+)([^\s]+)/.exec(value);
	return match?.[1]?.replace(/^['"]|['"]$/g, "");
}

export async function createRunDirectory(
	ctx: ExtensionContext,
	workflowName: string,
	started: number,
): Promise<{ runId: string; runDir: string }> {
	const root = getRunRoot(ctx);
	await ensureDir(root);
	const timestamp = new Date(started).toISOString().replace(/[:.]/g, "-");
	for (let attempt = 0; attempt < 10; attempt++) {
		const runId = `${timestamp}-${slugify(workflowName)}-${crypto.randomBytes(4).toString("hex")}`;
		const runDir = path.join(root, runId);
		try {
			await fs.mkdir(runDir);
			return { runId, runDir };
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
		}
	}
	throw new Error("Could not create a unique workflow run directory.");
}
