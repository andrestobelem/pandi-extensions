/**
 * Writer de run-report watched.
 *
 * Es dueño del loop de regeneración server-side para `/workflow report --watch` y
 * `dynamic_workflow action=report watch:true`: report.html se regenera
 * atómicamente mientras el run está live-running, y el snapshot terminal final se
 * escribe sin auto-refresh del browser.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { WorkflowRunRecord, WorkflowRunStatus } from "./index.js";
import { collectRunReport } from "./run-report-collector.js";
import { buildRunReportHtml } from "./run-report-html.js";
import { readRunStatus, writeTextFileAtomic } from "./run-store.js";

export const RUN_REPORT_WATCH_INTERVAL_MS = 2000;

export interface RunReportWriteResult {
	reportPath: string;
	state: string;
	iterations: number;
	refreshing: boolean;
}

export interface RunReportWriteOptions {
	outPath?: string;
	watch?: boolean;
	signal?: AbortSignal;
	intervalMs?: number;
	/** Seam de test para liveness; producción usa readRunStatus. */
	readStatus?: (runDir: string) => Promise<WorkflowRunStatus | undefined>;
	/** Hook de test y seam de observabilidad: se llama después de cada escritura atómica. */
	onWrite?: (result: RunReportWriteResult, html: string) => void | Promise<void>;
}

function targetPath(run: WorkflowRunRecord, outPath?: string): string {
	return outPath ?? path.join(run.runDir, "report.html");
}

async function currentScriptCode(run: WorkflowRunRecord): Promise<string | null> {
	try {
		return await fs.readFile(run.file, "utf8");
	} catch {
		return null;
	}
}

function refreshSeconds(intervalMs: number): number {
	return Math.max(1, Math.ceil(intervalMs / 1000));
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) return Promise.reject(new Error("Run report watch aborted."));
	return new Promise((resolve, reject) => {
		const timer = setTimeout(done, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(new Error("Run report watch aborted."));
		};
		function done() {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

export async function writeRunReportOnce(
	run: WorkflowRunRecord,
	options: RunReportWriteOptions = {},
): Promise<RunReportWriteResult> {
	const intervalMs = options.intervalMs ?? RUN_REPORT_WATCH_INTERVAL_MS;
	const liveStatus = await (options.readStatus ?? readRunStatus)(run.runDir);
	const model = await collectRunReport(run.runDir, {
		...(liveStatus ? { liveStatus } : {}),
		currentScriptCode: await currentScriptCode(run),
	});
	const refreshing = Boolean(options.watch && model.state === "running");
	const html = buildRunReportHtml({
		...model,
		...(refreshing ? { autoRefreshSeconds: refreshSeconds(intervalMs) } : {}),
	});
	const reportPath = targetPath(run, options.outPath);
	await writeTextFileAtomic(reportPath, html);
	const result = { reportPath, state: model.state, iterations: 1, refreshing };
	await options.onWrite?.(result, html);
	return result;
}

export async function watchRunReport(
	run: WorkflowRunRecord,
	options: RunReportWriteOptions = {},
): Promise<RunReportWriteResult> {
	const intervalMs = options.intervalMs ?? RUN_REPORT_WATCH_INTERVAL_MS;
	let iterations = 0;
	while (true) {
		const snapshot = await writeRunReportOnce(run, { ...options, watch: true, intervalMs });
		iterations++;
		const result = { ...snapshot, iterations };
		if (snapshot.state !== "running") return result;
		await wait(intervalMs, options.signal);
	}
}

export async function writeRunReport(
	run: WorkflowRunRecord,
	options: RunReportWriteOptions = {},
): Promise<RunReportWriteResult> {
	if (options.watch) return await watchRunReport(run, options);
	return await writeRunReportOnce(run, options);
}
