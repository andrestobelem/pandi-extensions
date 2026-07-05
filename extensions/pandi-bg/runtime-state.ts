/**
 * pandi-bg in-process runtime registry: the `activeJobs` map (the ES-module
 * singleton tracking jobs this session owns) plus the tiny shared helpers
 * (nowIso, appendEvent, asString, asNumber).
 *
 * Extracted verbatim from index.ts (behavior-preserving). The `activeJobs`
 * Map is a single shared instance imported back into index.ts so every
 * get/set/has/delete/values call site operates on the same identity. The
 * RuntimeJob type stays declared in index.ts (the runner/jobs hub) and is
 * imported here type-only, so there is no runtime import cycle.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { RuntimeJob } from "./index.js";

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
