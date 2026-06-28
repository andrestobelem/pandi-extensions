/**
 * Resumable-runs content-address cache journal for dynamic-workflows.
 *
 * Journaling/cache subsystem: deterministic call keys (stableStringify +
 * computeCallKey), code hashing (computeCodeHash), reading/appending the
 * per-run journal.jsonl (loadJournal / appendJournalRecord), result
 * normalization for journaling, and the agent-id / artifact-number derivations
 * that keep resume idempotent. Moved verbatim from index.ts (behavior-preserving).
 *
 * Runtime deps from index.ts (appendJsonLine, transformWorkflowCode, and the
 * JOURNAL_FILE / MAX_* budgets) are used ONLY inside function bodies, so the
 * journal.ts <-> index.ts ESM cycle is fully deferred (no top-level cross-use);
 * types come via `import type` (erased). Depth-one sibling so it ships under
 * the `files` glob.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import {
	appendJsonLine,
	transformWorkflowCode,
	JOURNAL_FILE,
	MAX_AGENT_OUTPUT_IN_RESULT,
	MAX_JOURNALED_STREAM,
} from "./index.js";
import { truncate } from "./format.js";
import type { JournalCache, JournalRecord, SubagentResult, BashResult } from "./index.js";

// --- Resumable runs: content-address cache journal ---

// Deterministic JSON: object keys sorted recursively so identical args always
// produce the same string regardless of key insertion order. undefined values
// are dropped (mirroring JSON.stringify); arrays keep their order.
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

// Parse journal.jsonl into a key -> array(occ) map (last-wins per (key, occ)).
// Tolerant of a torn final line (same convention as readRunLogEvents): the last
// line is discarded if it does not parse, since a crash can truncate it.
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
			// A crash can leave the final JSONL record torn; tolerate only that case.
			if (i === lastContentLine) continue;
			console.warn(
				`[dynamic-workflows] Ignoring malformed journal line ${i + 1} in ${journalPath}; resume cache may be incomplete.`,
			);
			continue;
		}
		if (
			!record ||
			typeof record.key !== "string" ||
			typeof record.occ !== "number" ||
			!record.result
		)
			continue;
		const slots = cache.get(record.key) ?? [];
		slots[record.occ] = record.result; // last-wins for a repeated (key, occ)
		cache.set(record.key, slots);
	}
	return cache;
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

// Highest agent id recorded in the journal. A count is NOT safe here: the
// journal can be non-contiguous (gaps from in-flight/{cache:false} agents that
// never journaled, or out-of-order completion under concurrency), so resumed
// runs must start agentCount strictly above the max existing id, never the
// count, or a fresh agents/NNNN would clobber a cached artifact on disk.
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

// Highest NNNN prefix among agents/NNNN-*.md artifacts already on disk. This
// covers ids that were never journaled (e.g. {cache:false} agents from the
// original run), so resumed agentCount also clears those and never overwrites
// any existing artifact.
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
