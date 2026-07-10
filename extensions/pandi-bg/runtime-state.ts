/**
 * Registro runtime in-process de pandi-bg: el map `activeJobs` (el singleton ES-module
 * que trackea jobs que posee esta sesión) más los helpers compartidos mínimos
 * (nowIso, appendEvent, asString, asNumber).
 *
 * Extraído verbatim de index.ts (preserva comportamiento). El Map `activeJobs`
 * es una única instancia compartida importada de vuelta en index.ts para que todo
 * call site get/set/has/delete/values opere sobre la misma identidad. El tipo
 * RuntimeJob vive en types.ts (hoja sin runtime) para evitar ciclos con index.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { RuntimeJob } from "./types.js";

export const activeJobs = new Map<string, RuntimeJob>();

export function nowIso(): string {
	return new Date().toISOString();
}

export async function appendEvent(runDir: string, event: Record<string, unknown>): Promise<void> {
	await fs
		.appendFile(path.join(runDir, "events.jsonl"), `${JSON.stringify({ time: nowIso(), ...event })}\n`, "utf8")
		.catch(() => undefined);
}

export function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

export function asNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
