/**
 * pi-bg storage layer: path layout (project/global run roots), directory-safety
 * helpers (no symlinks / path escape), bounded JSON read, and atomic JSON write.
 *
 * Extracted verbatim from index.ts (behavior-preserving) to isolate the pure,
 * activeJobs-free filesystem concerns. Depth-one sibling module imported by
 * index.ts via "./storage.js". The runner/jobs concerns (streams, activeJobs,
 * status derivation) deliberately stay in index.ts.
 */

import { CONFIG_DIR_NAME, getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

export const BG_DIR = "bg";
export const RUNS_DIR = "runs";
export const MAX_JSON_BYTES = 1_000_000;

export interface CandidateRunRoot {
	root: string;
	baseDir: string;
}

export function stableHash(value: string): string {
	return crypto.createHash("sha1").update(value).digest("hex").slice(0, 12);
}

export function getProjectBgRoot(ctx: ExtensionContext): string {
	return path.join(ctx.cwd, CONFIG_DIR_NAME, BG_DIR);
}

export function getGlobalBgRoot(_ctx: ExtensionContext): string {
	return path.join(getAgentDir(), BG_DIR);
}

export function candidateRunRoots(ctx: ExtensionContext): CandidateRunRoot[] {
	const roots: CandidateRunRoot[] = [];
	if (ctx.isProjectTrusted()) roots.push({ root: path.join(getProjectBgRoot(ctx), RUNS_DIR), baseDir: ctx.cwd });
	const globalRuns = path.join(getGlobalBgRoot(ctx), RUNS_DIR, stableHash(ctx.cwd));
	if (!roots.some((entry) => entry.root === globalRuns)) roots.push({ root: globalRuns, baseDir: getAgentDir() });
	return roots;
}

export function validJobId(jobId: string): boolean {
	return /^(?!\.{1,2}$)[A-Za-z0-9][A-Za-z0-9._-]*$/.test(jobId);
}

export function generateJobId(): string {
	return `bg-${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`;
}

export async function lstatPlainDirectory(dir: string): Promise<boolean> {
	try {
		const stat = await fs.lstat(dir);
		return stat.isDirectory() && !stat.isSymbolicLink();
	} catch {
		return false;
	}
}

export async function lstatPlainDirectoryChain(baseDir: string, dir: string): Promise<boolean> {
	const base = path.resolve(baseDir);
	const target = path.resolve(dir);
	const relative = path.relative(base, target);
	if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return false;
	let current = base;
	for (const part of relative.split(path.sep).filter(Boolean)) {
		current = path.join(current, part);
		if (!(await lstatPlainDirectory(current))) return false;
	}
	return true;
}

export async function ensurePlainDirectory(dir: string): Promise<void> {
	try {
		await fs.mkdir(dir);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
	}
	if (!(await lstatPlainDirectory(dir))) throw new Error(`Refusing to use non-directory or symlink: ${dir}`);
}

export async function createRunDir(ctx: ExtensionContext, jobId: string): Promise<string> {
	const piDir = path.join(ctx.cwd, CONFIG_DIR_NAME);
	const bgDir = path.join(piDir, BG_DIR);
	const runsDir = path.join(bgDir, RUNS_DIR);
	await ensurePlainDirectory(piDir);
	await ensurePlainDirectory(bgDir);
	await ensurePlainDirectory(runsDir);
	const runDir = path.join(runsDir, jobId);
	await ensurePlainDirectory(runDir);
	return runDir;
}

export async function isRegularFile(file: string): Promise<boolean> {
	try {
		const stat = await fs.lstat(file);
		return stat.isFile() && stat.size <= MAX_JSON_BYTES;
	} catch {
		return false;
	}
}

export async function readJson(file: string): Promise<Record<string, unknown> | undefined> {
	try {
		if (!(await isRegularFile(file))) return undefined;
		const parsed = JSON.parse(await fs.readFile(file, "utf8"));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}

export async function atomicWriteJson(file: string, value: unknown): Promise<void> {
	const tmp = path.join(
		path.dirname(file),
		`.${path.basename(file)}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString("hex")}.tmp`,
	);
	await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
	try {
		await fs.rename(tmp, file);
	} catch (err) {
		await fs.rm(tmp, { force: true }).catch(() => undefined);
		throw err;
	}
}

// Best-effort append-only audit of irreversible removals, at .pi/bg/runs/.audit.jsonl.
// The leading dot means validJobId() rejects it, so every job-enumeration loop skips
// it for free (no pollution of list/reconcile/prune). Never throws into the caller.
export async function appendAuditLine(ctx: ExtensionContext, entry: Record<string, unknown>): Promise<void> {
	const auditFile = path.join(getProjectBgRoot(ctx), RUNS_DIR, ".audit.jsonl");
	try {
		await fs.appendFile(
			auditFile,
			`${JSON.stringify({ ts: new Date().toISOString(), scope: "project", ...entry })}\n`,
			"utf8",
		);
	} catch {
		// audit is best-effort evidence; it must never block the operation it records
	}
}

// Remove a single project-local run directory, symlink/path-safe. Immediately before
// fs.rm it re-asserts the jobId and the full path chain (no symlinked component, no
// escape from the project runs root). fs.rm(recursive) lstats each entry, so a
// malicious inner symlink (e.g. combined.log -> /etc/...) is unlinked, not followed.
// Returns false (nothing removed) when the dir is missing, symlinked, or out of scope.
export async function removeRunDir(
	ctx: ExtensionContext,
	jobId: string,
	audit: { verb: string; state?: string; sizeBytes?: number },
	revalidate?: (status: Record<string, unknown> | undefined) => boolean | Promise<boolean>,
): Promise<boolean> {
	if (!validJobId(jobId)) return false;
	const runDir = path.join(getProjectBgRoot(ctx), RUNS_DIR, jobId);
	if (!(await lstatPlainDirectoryChain(ctx.cwd, runDir))) return false;
	if (!(await lstatPlainDirectory(runDir))) return false;
	// Edge re-validation: re-read status and let the caller re-derive deletability
	// immediately before the irreversible fs.rm, closing the classify->remove window.
	if (revalidate && !(await revalidate(await readJson(path.join(runDir, "status.json"))))) return false;
	await fs.rm(runDir, { recursive: true, force: true });
	await appendAuditLine(ctx, {
		verb: audit.verb,
		jobId,
		state: audit.state ?? null,
		sizeBytes: audit.sizeBytes ?? null,
	});
	return true;
}
