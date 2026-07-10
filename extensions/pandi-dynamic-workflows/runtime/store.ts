/**
 * Store de persistencia de run/status para dynamic-workflows.
 *
 * Lee y escribe los registros on-disk por run (result.json, status.json) y
 * descubre directorios de run: writeJsonFile atómico (temp + rename), writeRunStatus,
 * readRunResult / readRunStatus / readRunRecord y getRunDirs (dirs de run ordenados por mtime
 * entre roots). Movido textualmente desde index.ts (preserva comportamiento), incluida
 * la derivación live de staleness de readRunStatus contra el registro de runs activos.
 *
 * Las deps runtime desde index.ts (getRunRoots) y lifecycle/registry, más safeJson desde
 * ./format.js, se usan SOLO dentro de cuerpos de función, así que el ciclo ESM run-store.ts <-> index.ts
 * queda totalmente diferido (sin uso cruzado top-level); los tipos vienen vía `import type`
 * (borrados). Sibling de profundidad uno para que se shipee bajo el glob `files`.
 */

import * as crypto from "node:crypto";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { safeJson } from "../format.js";
import { hasActiveRun } from "../lifecycle/index.js";
import { getRunRoots } from "../surface/index.js";
import type { WorkflowRunRecord, WorkflowRunResult, WorkflowRunStatus } from "../types.js";

export async function getRunDirs(ctx: ExtensionContext): Promise<string[]> {
	const dirs: { full: string; mtimeMs: number }[] = [];
	for (const root of getRunRoots(ctx)) {
		if (!existsSync(root)) continue;
		const entries = await fs.readdir(root, { withFileTypes: true });
		dirs.push(
			...(await Promise.all(
				entries
					.filter((entry) => entry.isDirectory())
					.map(async (entry) => {
						const full = path.join(root, entry.name);
						const stat = await fs.stat(full);
						return { full, mtimeMs: stat.mtimeMs };
					}),
			)),
		);
	}
	return dirs.sort((a, b) => b.mtimeMs - a.mtimeMs).map((entry) => entry.full);
}

export async function writeTextFileAtomic(file: string, content: string): Promise<void> {
	// Escritura atómica: escribí a un temp sibling único y luego renombrá, para que un crash a mitad de escritura
	// nunca deje atrás un archivo generado truncado/corrupto.
	const temp = `${file}.${crypto.randomBytes(6).toString("hex")}.tmp`;
	await fs.writeFile(temp, content, "utf8");
	try {
		await fs.rename(temp, file);
	} catch (err) {
		await fs.rm(temp, { force: true }).catch(() => {});
		throw err;
	}
}

export async function writeJsonFile(file: string, value: unknown): Promise<void> {
	// Escritura atómica: escribí a un archivo temp único y luego renombrá, para que un crash a mitad de escritura
	// nunca deje atrás un status.json o result.json truncado/corrupto.
	await writeTextFileAtomic(file, `${safeJson(value)}\n`);
}

export async function writeRunStatus(status: WorkflowRunStatus): Promise<void> {
	await writeJsonFile(path.join(status.runDir, "status.json"), status);
}

export async function readRunResult(runDir: string): Promise<WorkflowRunResult | undefined> {
	try {
		return JSON.parse(await fs.readFile(path.join(runDir, "result.json"), "utf8")) as WorkflowRunResult;
	} catch {
		return undefined;
	}
}

export async function readRunStatus(runDir: string): Promise<WorkflowRunStatus | undefined> {
	try {
		const status = JSON.parse(await fs.readFile(path.join(runDir, "status.json"), "utf8")) as WorkflowRunStatus;
		if (status.state === "running" && !hasActiveRun(status.runId)) {
			const now = Date.now();
			const started = new Date(status.startedAt).getTime();
			return {
				...status,
				state: "stale",
				active: false,
				updatedAt: new Date(now).toISOString(),
				elapsedMs: Number.isFinite(started) ? now - started : status.elapsedMs,
			};
		}
		return { ...status, active: status.state === "running" && hasActiveRun(status.runId) };
	} catch {
		return undefined;
	}
}

export async function readRunRecord(runDir: string): Promise<WorkflowRunRecord | undefined> {
	const result = await readRunResult(runDir);
	if (result) return result;
	return await readRunStatus(runDir);
}
