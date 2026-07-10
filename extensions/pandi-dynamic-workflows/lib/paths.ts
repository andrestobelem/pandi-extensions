/**
 * Layout de filesystem para workflows — constantes de directorio, slugify, projectHash,
 * roots de run/graph y createRunDirectory. Helpers puros sin lógica de resolución de archivos.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { CONFIG_DIR_NAME, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";

export const WORKFLOW_DIR = "workflows";
export const WORKFLOW_DRAFT_DIR = path.join(WORKFLOW_DIR, "drafts");
export const WORKFLOW_RUN_DIR = path.join(WORKFLOW_DIR, "runs");
export const WORKFLOW_GRAPH_DIR = path.join(WORKFLOW_DIR, "graphs");

export function slugify(value: string): string {
	const slug = value
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 80);
	return slug || "workflow";
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

export async function ensureDir(dir: string): Promise<void> {
	await fs.mkdir(dir, { recursive: true });
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
