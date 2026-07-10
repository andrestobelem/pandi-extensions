/**
 * Lectura pura de status.json de un run.
 *
 * El staleness check (marcar un run que no está más activo como "stale")
 * se inyecta vía el callback opcional `isActiveRun`, así lib no depende de
 * lifecycle ni runtime.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { WorkflowRunStatus } from "../types.js";

export async function readRunStatus(
	runDir: string,
	isActiveRun?: (runId: string) => boolean,
): Promise<WorkflowRunStatus | undefined> {
	try {
		const status = JSON.parse(await fs.readFile(path.join(runDir, "status.json"), "utf8")) as WorkflowRunStatus;
		if (status.state === "running" && isActiveRun && !isActiveRun(status.runId)) {
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
		return { ...status, active: status.state === "running" && (isActiveRun?.(status.runId) ?? false) };
	} catch {
		return undefined;
	}
}
