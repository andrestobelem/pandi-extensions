/**
 * Diario de cache de content-address para runs resumibles en dynamic-workflows.
 *
 * Subsistema journaling/cache: deterministic call keys (stableStringify +
 * computeCallKey), code hashing (computeCodeHash), reading/appending del
 * per-run journal.jsonl (loadJournal / appendJournalRecord), result normalization
 * para journaling, y las derivaciones agent-id / artifact-number que mantienen
 * resume idempotente. Movido verbatim desde index.ts (behavior-preserving).
 *
 * Runtime deps desde index.ts (appendJsonLine, transformWorkflowCode, y los
 * budgets JOURNAL_FILE / MAX_*) se usan SOLO dentro de bodies de función, así
 * el ciclo ESM journal.ts <-> index.ts está completamente deferred (sin top-level
 * cross-use); types vienen via `import type` (erased). Sibling a profundidad uno
 * así se incluye bajo el glob `files`.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { appendJsonLine } from "./file-append.js";
import { truncate } from "./format.js";
import type { AskResult, BashResult, JournalCache, JournalRecord, SubagentResult } from "./index.js";
import { JOURNAL_FILE, MAX_AGENT_OUTPUT_IN_RESULT, MAX_JOURNALED_STREAM, transformWorkflowCode } from "./index.js";

// --- Runs resumibles: diario de cache content-address ---

// JSON determinístico: object keys ordenadas recursivamente así args idénticos siempre
// producen el mismo string independientemente del key insertion order. Los valores undefined
// se descartan (espejando JSON.stringify); arrays mantienen su orden.
export function stableStringify(value: unknown): string {
	const seen = new WeakSet<object>();
	const encode = (current: unknown): string => {
		if (current === null) return "null";
		const t = typeof current;
		if (typeof current === "number") return Number.isFinite(current) ? String(current) : "null";
		if (typeof current === "boolean") return String(current);
		if (t === "bigint") return JSON.stringify((current as bigint).toString());
		if (t === "string") return JSON.stringify(current);
		if (t === "undefined" || t === "function" || t === "symbol") return "null";
		if (Array.isArray(current)) {
			if (seen.has(current)) return '"[Circular]"';
			seen.add(current);
			const out = `[${current.map((item) => encode(item)).join(",")}]`;
			seen.delete(current);
			return out;
		}
		const obj = current as Record<string, unknown>;
		if (seen.has(obj)) return '"[Circular]"';
		seen.add(obj);
		const keys = Object.keys(obj)
			.filter((key) => {
				const v = obj[key];
				return v !== undefined && typeof v !== "function" && typeof v !== "symbol";
			})
			.sort();
		const out = `{${keys.map((key) => `${JSON.stringify(key)}:${encode(obj[key])}`).join(",")}}`;
		seen.delete(obj);
		return out;
	};
	return encode(value);
}

export function computeCallKey(method: string, args: unknown): string {
	return crypto
		.createHash("sha256")
		.update(`${method}\n${stableStringify(args)}`)
		.digest("hex");
}

export function computeCodeHash(code: string): string {
	return crypto.createHash("sha256").update(transformWorkflowCode(code)).digest("hex");
}

// Parsea journal.jsonl en un key -> array(occ) map (last-wins per (key, occ)).
// Tolerante de una torn final line (misma convención como readRunLogEvents): la última
// línea se descarta si no parsea, ya que un crash puede truncarla.
export async function loadJournal(runDir: string): Promise<JournalCache> {
	const cache: JournalCache = new Map();
	let body: string;
	try {
		body = await fs.readFile(path.join(runDir, JOURNAL_FILE), "utf8");
	} catch {
		return cache;
	}
	const journalPath = path.join(runDir, JOURNAL_FILE);
	const lines = body.split("\n");
	let lastContentLine = -1;
	for (let i = lines.length - 1; i >= 0; i--) {
		if (lines[i].trim()) {
			lastContentLine = i;
			break;
		}
	}
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (!line.trim()) continue;
		let record: JournalRecord;
		try {
			record = JSON.parse(line) as JournalRecord;
		} catch {
			// Un crash puede dejar el final JSONL record torn; tolerate solo ese caso.
			if (i === lastContentLine) continue;
			console.warn(
				`[dynamic-workflows] Ignoring malformed journal line ${i + 1} in ${journalPath}; resume cache may be incomplete.`,
			);
			continue;
		}
		if (!record || typeof record.key !== "string" || typeof record.occ !== "number" || !record.result) continue;
		const slots = cache.get(record.key) ?? [];
		slots[record.occ] = record.result; // last-wins para (key, occ) repetido
		cache.set(record.key, slots);
	}
	return cache;
}

// Lee un cached result para (key, occ) desde un loaded journal cache. Devuelve undefined cuando
// absent: unknown key, occ pasado los recorded slots, o fresh non-resumed run (no cache).
// Pure read counterpart a loadJournal/appendJournalRecord — el llamador es dueño del JournalCache
// y la serialization; esto nunca muta.
export function lookupJournalRecord(
	cache: JournalCache | undefined,
	key: string,
	occ: number,
): SubagentResult | BashResult | AskResult | undefined {
	return cache?.get(key)?.[occ];
}

export async function appendJournalRecord(runDir: string, record: JournalRecord): Promise<void> {
	await appendJsonLine(path.join(runDir, JOURNAL_FILE), record);
}

export function normalizeSubagentResultForJournal(result: SubagentResult): SubagentResult {
	return {
		...result,
		output: truncate(result.output, MAX_AGENT_OUTPUT_IN_RESULT),
		stdout: truncate(result.stdout, MAX_JOURNALED_STREAM),
		stderr: truncate(result.stderr, MAX_JOURNALED_STREAM),
	};
}

export function normalizeBashResultForJournal(result: BashResult): BashResult {
	return {
		...result,
		stdout: truncate(result.stdout, MAX_JOURNALED_STREAM),
		stderr: truncate(result.stderr, MAX_JOURNALED_STREAM),
	};
}

// Highest agent id registrado en el journal. Un count NO es seguro aquí: el
// journal puede ser non-contiguous (gaps desde in-flight/{cache:false} agents que
// nunca journaled, o out-of-order completion bajo concurrency), así resumed
// runs deben iniciar agentCount estrictamente arriba del max existing id, nunca el
// count, o un fresh agents/NNNN clobberíaría un cached artifact en disk.
export function maxJournalAgentId(cache: JournalCache): number {
	let max = 0;
	for (const slots of cache.values()) {
		for (const result of slots) {
			if (result && "artifactPath" in result && typeof result.id === "number" && result.id > max) {
				max = result.id;
			}
		}
	}
	return max;
}

// Highest NNNN prefix entre agents/NNNN-*.md artifacts ya en disk. Esto cubre
// ids que nunca fueron journaled (p. ej. {cache:false} agents del original run),
// así resumed agentCount también limpia esos y nunca sobrescribe ningún existing artifact.
export async function maxAgentArtifactNumber(runDir: string): Promise<number> {
	let max = 0;
	let names: string[];
	try {
		names = await fs.readdir(path.join(runDir, "agents"));
	} catch {
		return 0;
	}
	for (const name of names) {
		const m = /^(\d{4})-/.exec(name);
		if (m) {
			const n = Number.parseInt(m[1], 10);
			if (Number.isFinite(n) && n > max) max = n;
		}
	}
	return max;
}
