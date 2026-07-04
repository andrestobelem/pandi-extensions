/**
 * Run configuration for dynamic workflows: the limit defaults/ceilings plus the
 * input-normalization and limit-building helpers that turn raw tool/CLI input
 * into a normalized input object and a clamped RunLimits.
 *
 * Pure and self-contained at depth one under extensions/pandi-dynamic-workflows, so
 * it matches the package `files` glob and is bundled into index.ts (jiti at
 * runtime, esbuild in tests). The only dependency back on index.ts is TYPE-only
 * (DynamicWorkflowToolParams, RunLimits); `import type` is erased at build time,
 * so there is no runtime import cycle.
 */

import type { DynamicWorkflowToolParams, RunLimits } from "./index.js";

export const DEFAULT_MAX_AGENTS = 64;
export const HARD_MAX_AGENTS = 1000;
export const DEFAULT_CONCURRENCY = 4;
export const HARD_MAX_CONCURRENCY = 16;
export const DEFAULT_AGENT_TIMEOUT_MS = 10 * 60_000;
export const DEFAULT_WORKFLOW_TIMEOUT_MS = 60 * 60_000;
export const DEFAULT_SYNC_TIMEOUT_MS = 5_000;

function looksLikeJson(value: string): boolean {
	return /^(?:[[{"]|true\b|false\b|null\b|-?\d)/.test(value.trim());
}

export function parseCliJsonOrText(raw: string | undefined, options: { strictJson?: boolean } = {}): unknown {
	const value = raw?.trim();
	if (!value) return {};
	try {
		return JSON.parse(value);
	} catch (err) {
		if (options.strictJson || looksLikeJson(value)) {
			throw new Error(`Invalid JSON input: ${err instanceof Error ? err.message : String(err)}`, {
				cause: err,
			});
		}
		return { text: value };
	}
}

// The tool-call path can deliver `input` as a JSON string instead of a parsed
// object (e.g. when tool arguments are marshaled as text). Coerce strings the
// same way the CLI/editor paths do, so workflows reliably receive an object and
// `input?.x` fields are honored instead of being silently undefined.
export function normalizeWorkflowInput(input: unknown): unknown {
	if (typeof input !== "string") return input ?? {};
	return parseCliJsonOrText(input);
}

export function limitParamsFromInput(input: unknown): Partial<DynamicWorkflowToolParams> {
	if (!input || typeof input !== "object" || Array.isArray(input)) return {};
	const record = input as Record<string, unknown>;
	const out: Partial<DynamicWorkflowToolParams> = {};
	for (const key of ["concurrency", "maxAgents", "timeoutMs", "agentTimeoutMs"] as const) {
		if (typeof record[key] === "number" && Number.isFinite(record[key])) out[key] = record[key];
	}
	return out;
}

export function buildLimits(params: Partial<DynamicWorkflowToolParams> = {}): RunLimits {
	const concurrency = Math.min(
		Math.max(Math.floor(params.concurrency ?? DEFAULT_CONCURRENCY), 1),
		HARD_MAX_CONCURRENCY,
	);
	const maxAgents = Math.min(Math.max(Math.floor(params.maxAgents ?? DEFAULT_MAX_AGENTS), 1), HARD_MAX_AGENTS);
	return {
		concurrency,
		maxAgents,
		timeoutMs: Math.max(Math.floor(params.timeoutMs ?? DEFAULT_WORKFLOW_TIMEOUT_MS), 1_000),
		agentTimeoutMs: Math.max(Math.floor(params.agentTimeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS), 1_000),
		syncTimeoutMs: DEFAULT_SYNC_TIMEOUT_MS,
	};
}
