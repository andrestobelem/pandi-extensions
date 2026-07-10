/**
 * Configuración de runs para dynamic workflows: defaults/techos de límites más los
 * helpers de normalización de input y construcción de límites que convierten input raw
 * de tool/CLI en un objeto input normalizado y RunLimits clampados.
 *
 * Puro y autocontenido a profundidad uno bajo extensions/pandi-dynamic-workflows, así
 * matchea el glob `files` del paquete y se bundlea en index.ts (jiti en runtime,
 * esbuild en tests). La única dependencia de vuelta hacia index.ts es SOLO de TIPOS
 * (DynamicWorkflowToolParams, RunLimits); `import type` se borra en build time,
 * así no hay ciclo de import runtime.
 */

import type { DynamicWorkflowToolParams, RunLimits } from "../types.js";

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

// La ruta tool-call puede entregar `input` como string JSON en vez de objeto parseado
// (p. ej. cuando los argumentos de tool se serializan como texto). Coercioná strings
// igual que las rutas CLI/editor, para que los workflows reciban confiablemente un objeto y
// los campos `input?.x` se respeten en vez de quedar silently undefined.
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

function clampInt(value: number, min: number, max: number): number {
	return Math.min(Math.max(Math.floor(value), min), max);
}

export function buildLimits(params: Partial<DynamicWorkflowToolParams> = {}): RunLimits {
	const concurrency = clampInt(params.concurrency ?? DEFAULT_CONCURRENCY, 1, HARD_MAX_CONCURRENCY);
	const maxAgents = clampInt(params.maxAgents ?? DEFAULT_MAX_AGENTS, 1, HARD_MAX_AGENTS);
	return {
		concurrency,
		maxAgents,
		timeoutMs: Math.max(Math.floor(params.timeoutMs ?? DEFAULT_WORKFLOW_TIMEOUT_MS), 1_000),
		agentTimeoutMs: Math.max(Math.floor(params.agentTimeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS), 1_000),
		syncTimeoutMs: DEFAULT_SYNC_TIMEOUT_MS,
	};
}
