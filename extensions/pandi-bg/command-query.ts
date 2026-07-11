/**
 * Handlers de consulta: list, status, logs, events.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type BgResponse, resolveRunDir, response } from "./command-shared.js";
import { formatJob, listJobs } from "./job-listing.js";
import { decorateStatus, refineOrphanedIdentity } from "./job-state.js";
import { asNumber, asString } from "./runtime-state.js";
import { readJson } from "./storage.js";

const MAX_LOG_BYTES = 20_000;

export async function handleList(ctx: ExtensionContext): Promise<BgResponse> {
	const jobs = await listJobs(ctx);
	if (jobs.length === 0) return response("No se encontraron jobs en segundo plano.", { jobs: [] });
	return response(["Jobs en segundo plano:", ...jobs.map(formatJob)].join("\n"), { jobs });
}

export async function handleStatus(ctx: ExtensionContext, jobId: string): Promise<BgResponse> {
	const runDir = await resolveRunDir(ctx, jobId, "Uso: /bg status <jobId>");
	if (typeof runDir !== "string") return runDir;
	const job = (await readJson(path.join(runDir, "job.json"))) ?? {};
	const rawStatus = (await readJson(path.join(runDir, "status.json"))) ?? {};
	const status = decorateStatus(jobId, rawStatus);
	if (status.state === "orphaned") {
		const pid = asNumber(status.pid);
		const refined = refineOrphanedIdentity(pid, asString(status.startId));
		if (refined.state === "interrupted") {
			status.state = "interrupted";
			delete status.hint;
			status.interruptedCause = "pid-reused";
		} else if (refined.verified) {
			status.identity = "verified";
			status.hint = `El PID ${pid} está verificado y sigue corriendo (misma identidad de inicio). Detenélo con kill -- -${pid} / taskkill; /bg cancel no le va a enviar una señal a un PID persistido.`;
		}
	}
	return response(JSON.stringify({ jobId, artifactsDir: runDir, job, status }, null, 2), {
		jobId,
		artifactsDir: runDir,
		job,
		status,
	});
}

async function isReadableLogFile(file: string): Promise<boolean> {
	try {
		return (await fs.lstat(file)).isFile();
	} catch {
		return false;
	}
}

async function readBoundedLog(file: string): Promise<string | undefined> {
	let handle: fs.FileHandle | undefined;
	try {
		if (!(await isReadableLogFile(file))) return undefined;
		handle = await fs.open(file, "r");
		const stat = await handle.stat();
		const bytesToRead = Math.min(stat.size, MAX_LOG_BYTES);
		const buffer = Buffer.alloc(bytesToRead);
		await handle.read(buffer, 0, bytesToRead, Math.max(0, stat.size - bytesToRead));
		const truncated = stat.size > MAX_LOG_BYTES;
		let start = 0;
		if (truncated) {
			while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start++;
		}
		const data = buffer.subarray(start).toString("utf8");
		if (!truncated) return data;
		return `[truncado a los últimos ${MAX_LOG_BYTES} bytes]\n${data}`;
	} catch {
		return undefined;
	} finally {
		await handle?.close().catch(() => undefined);
	}
}

async function boundedArtifactResponse(
	runDir: string,
	jobId: string,
	file: string,
	source: string,
	emptyText: string,
): Promise<BgResponse | undefined> {
	const text = await readBoundedLog(path.join(runDir, file));
	if (text === undefined) return undefined;
	return response(text || emptyText, { jobId, source, truncatedTo: MAX_LOG_BYTES });
}

export async function handleLogs(ctx: ExtensionContext, jobId: string): Promise<BgResponse> {
	const runDir = await resolveRunDir(ctx, jobId, "Uso: /bg logs <jobId>");
	if (typeof runDir !== "string") return runDir;
	const combined = await boundedArtifactResponse(runDir, jobId, "combined.log", "combined.log", "(empty log)");
	if (combined) return combined;
	const stdout = await readBoundedLog(path.join(runDir, "stdout.log"));
	const stderr = await readBoundedLog(path.join(runDir, "stderr.log"));
	if (stdout === undefined && stderr === undefined)
		return response(`No se encontraron logs para ${jobId}.`, { jobId, found: true, logs: false }, "warning");
	return response(
		[
			stdout !== undefined ? `== stdout ==\n${stdout}` : undefined,
			stderr !== undefined ? `== stderr ==\n${stderr}` : undefined,
		]
			.filter(Boolean)
			.join("\n"),
		{
			jobId,
			source: "stdout/stderr",
			truncatedTo: MAX_LOG_BYTES,
		},
	);
}

export async function handleEvents(ctx: ExtensionContext, jobId: string): Promise<BgResponse> {
	const runDir = await resolveRunDir(ctx, jobId, "Uso: /bg events <jobId>");
	if (typeof runDir !== "string") return runDir;
	const events = await boundedArtifactResponse(runDir, jobId, "events.jsonl", "events.jsonl", "(no events)");
	if (events) return events;
	return response(`No se encontraron eventos para ${jobId}.`, { jobId, found: true, events: false }, "warning");
}
