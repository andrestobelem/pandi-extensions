/**
 * Run/status persistence store for dynamic-workflows.
 *
 * Reads and writes the per-run on-disk records (result.json, status.json) and
 * discovers run directories: atomic writeJsonFile (temp + rename), writeRunStatus,
 * readRunResult / readRunStatus / readRunRecord, and getRunDirs (mtime-sorted run
 * dirs across roots). Moved verbatim from index.ts (behavior-preserving), including
 * readRunStatus' live staleness derivation against activeRuns.
 *
 * Runtime deps from index.ts (getRunRoots, the activeRuns Map) and safeJson from
 * ./format.js are used ONLY inside function bodies, so the run-store.ts <-> index.ts
 * ESM cycle is fully deferred (no top-level cross-use); types come via `import type`
 * (erased). Depth-one sibling so it ships under the `files` glob.
 */

import * as crypto from "node:crypto";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { activeRuns } from "./index.js";
import { getRunRoots } from "./workflow-resolve.js";
import { safeJson } from "./format.js";
import type { WorkflowRunStatus, WorkflowRunResult, WorkflowRunRecord } from "./index.js";

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

export async function writeJsonFile(file: string, value: unknown): Promise<void> {
	// Atomic write: write to a unique temp file then rename, so a crash mid-write
	// never leaves a truncated/corrupt status.json or result.json behind.
	const temp = `${file}.${crypto.randomBytes(6).toString("hex")}.tmp`;
	await fs.writeFile(temp, `${safeJson(value)}\n`, "utf8");
	try {
		await fs.rename(temp, file);
	} catch (err) {
		await fs.rm(temp, { force: true }).catch(() => {});
		throw err;
	}
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
		if (status.state === "running" && !activeRuns.has(status.runId)) {
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
		return { ...status, active: status.state === "running" && activeRuns.has(status.runId) };
	} catch {
		return undefined;
	}
}

export async function readRunRecord(runDir: string): Promise<WorkflowRunRecord | undefined> {
	const result = await readRunResult(runDir);
	if (result) return result;
	return await readRunStatus(runDir);
}
