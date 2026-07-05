/**
 * Capa de storage de pandi-bg: layout de paths (project/global run roots), helpers de
 * seguridad de directorio (sin symlinks / escape de path), lectura JSON acotada y
 * escritura JSON atómica.
 *
 * Extraída verbatim de index.ts (preserva comportamiento) para aislar las preocupaciones
 * de filesystem puras y sin activeJobs. Módulo hermano de profundidad uno importado por
 * index.ts vía "./storage.js". Las preocupaciones de runner/jobs (streams, activeJobs,
 * derivación de status) quedan deliberadamente en index.ts.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { CONFIG_DIR_NAME, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";

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

async function safeLstat(p: string): Promise<Awaited<ReturnType<typeof fs.lstat>> | undefined> {
	try {
		return await fs.lstat(p);
	} catch {
		return undefined;
	}
}

export async function lstatPlainDirectory(dir: string): Promise<boolean> {
	const stat = await safeLstat(dir);
	return stat ? stat.isDirectory() && !stat.isSymbolicLink() : false;
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
	if (!(await lstatPlainDirectory(dir)))
		throw new Error(`Se rechaza usar algo que no es un directorio o es un symlink: ${dir}`);
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
	const stat = await safeLstat(file);
	return stat ? stat.isFile() && stat.size <= MAX_JSON_BYTES : false;
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

// Suma tamaños de archivos regulares bajo un run dir (lstat-walk vía Dirent; un symlink
// interno se omite, nunca se sigue, así que no puede inflar el total ni escapar del árbol).
export async function dirSizeBytes(dir: string): Promise<number> {
	let total = 0;
	let entries: {
		name: string;
		isDirectory(): boolean;
		isFile(): boolean;
		isSymbolicLink(): boolean;
	}[];
	try {
		entries = await fs.readdir(dir, { withFileTypes: true });
	} catch {
		return 0;
	}
	for (const entry of entries) {
		if (entry.isSymbolicLink()) continue;
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) total += await dirSizeBytes(full);
		else if (entry.isFile()) {
			try {
				total += (await fs.lstat(full)).size;
			} catch {
				// una entry ilegible no aporta nada
			}
		}
	}
	return total;
}

// Parseo mínimo de flags para /bg prune: solo --yes ejecuta; todo lo demás se ignora (sin
// otros flags en BG-4), así que un typo como --yse queda como dry-run seguro.
export function parsePruneFlags(tail: string): { yes: boolean } {
	return { yes: tail.trim().split(/\s+/).filter(Boolean).includes("--yes") };
}

// Auditoría append-only de mejor esfuerzo de eliminaciones irreversibles, en
// .pi/bg/runs/.audit.jsonl. El punto inicial hace que validJobId() lo rechace, así que todo
// loop de enumeración de jobs lo omite gratis (sin contaminar list/reconcile/prune). Nunca
// lanza hacia quien llama.
export async function appendAuditLine(ctx: ExtensionContext, entry: Record<string, unknown>): Promise<void> {
	const auditFile = path.join(getProjectBgRoot(ctx), RUNS_DIR, ".audit.jsonl");
	try {
		await fs.appendFile(
			auditFile,
			`${JSON.stringify({ ts: new Date().toISOString(), scope: "project", ...entry })}\n`,
			"utf8",
		);
	} catch {
		// audit es evidencia de mejor esfuerzo; nunca debe bloquear la operación que registra
	}
}

// Elimina un único run directory local del proyecto, symlink/path-safe. Justo antes de fs.rm
// reafirma el jobId y toda la cadena de path (sin componente symlinkeado, sin escape de la
// project runs root). fs.rm(recursive) hace lstat de cada entry, así que un symlink interno
// malicioso (p. ej. combined.log -> /etc/...) se deslinkea, no se sigue. Devuelve false
// (nada eliminado) cuando el dir falta, está symlinkeado o está fuera de scope.
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
	// Revalidación en el borde: relee status y deja que quien llama rederive eliminabilidad
	// justo antes del fs.rm irreversible, cerrando la ventana classify->remove.
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
