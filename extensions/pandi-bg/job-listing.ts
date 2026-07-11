/**
 * Enumeración y resolución de jobs persistidos en disco.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { deriveState } from "./job-state.js";
import { asString } from "./runtime-state.js";
import {
	candidateRunRoots,
	getProjectBgRoot,
	lstatPlainDirectory,
	lstatPlainDirectoryChain,
	RUNS_DIR,
	readJson,
	validJobId,
} from "./storage.js";
import type { JobState } from "./types.js";

export interface JobSummary {
	jobId: string;
	command?: string;
	state?: JobState;
	createdAt?: string;
	updatedAt?: string;
	artifactsDir: string;
}

export async function listJobs(ctx: ExtensionContext): Promise<JobSummary[]> {
	const jobs: JobSummary[] = [];
	for (const { root, baseDir } of candidateRunRoots(ctx)) {
		if (!(await lstatPlainDirectoryChain(baseDir, root))) continue;
		let entries: { name: string; isDirectory(): boolean }[];
		try {
			entries = await fs.readdir(root, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (!entry.isDirectory() || !validJobId(entry.name)) continue;
			const runDir = path.join(root, entry.name);
			if (!(await lstatPlainDirectory(runDir))) continue;
			const job = await readJson(path.join(runDir, "job.json"));
			const status = await readJson(path.join(runDir, "status.json"));
			jobs.push({
				jobId: entry.name,
				command: asString(job?.command),
				state: deriveState(entry.name, status),
				createdAt: asString(job?.createdAt),
				updatedAt: asString(status?.updatedAt),
				artifactsDir: runDir,
			});
		}
	}
	return jobs.sort((a, b) => (b.updatedAt ?? b.createdAt ?? "").localeCompare(a.updatedAt ?? a.createdAt ?? ""));
}

export async function findJobDir(ctx: ExtensionContext, jobId: string): Promise<string | undefined> {
	if (!validJobId(jobId)) return undefined;
	for (const { root, baseDir } of candidateRunRoots(ctx)) {
		if (!(await lstatPlainDirectoryChain(baseDir, root))) continue;
		const runDir = path.join(root, jobId);
		if (await lstatPlainDirectory(runDir)) return runDir;
	}
	return undefined;
}

// Enumera run dirs locales del proyecto (solo confiables), devolviendo {jobId, runDir, status}
// por cada job dir válido y sin symlink. Compartido por reconcile y prune para que los gates
// de trust/symlink/path y el salto del dotfile .audit.jsonl (validJobId rechaza el punto
// inicial) vivan en un solo lugar. El filtrado de sesión activa y la lógica de estado quedan
// en quien llama.
export async function eachProjectRunDir(
	ctx: ExtensionContext,
): Promise<{ jobId: string; runDir: string; status: Record<string, unknown> | undefined }[]> {
	if (!ctx.isProjectTrusted()) return [];
	const root = path.join(getProjectBgRoot(ctx), RUNS_DIR);
	if (!(await lstatPlainDirectoryChain(ctx.cwd, root))) return [];
	let entries: { name: string; isDirectory(): boolean }[];
	try {
		entries = await fs.readdir(root, { withFileTypes: true });
	} catch {
		return [];
	}
	const out: { jobId: string; runDir: string; status: Record<string, unknown> | undefined }[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory() || !validJobId(entry.name)) continue;
		const runDir = path.join(root, entry.name);
		if (!(await lstatPlainDirectory(runDir))) continue;
		out.push({
			jobId: entry.name,
			runDir,
			status: await readJson(path.join(runDir, "status.json")),
		});
	}
	return out;
}

export function formatJob(job: JobSummary): string {
	const command = job.command ? ` — ${job.command}` : "";
	const when = job.updatedAt ?? job.createdAt;
	return `- ${job.jobId}: ${job.state ?? "unknown"}${when ? ` (${when})` : ""}${command}`;
}
