/**
 * Serialized JSONL file append — a per-path AsyncMutex so concurrent writers to the same
 * events/journal file never interleave a partial line. A leaf used by the engine
 * (events.jsonl) and journal.ts (the resumable-run cache journal).
 *
 * Extracted byte-identically from index.ts.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { AsyncMutex } from "./concurrency-primitives.js";
import { safeJson } from "./format.js";

interface AppendMutexEntry {
	mutex: AsyncMutex;
	refs: number;
}
const appendFileMutexes = new Map<string, AppendMutexEntry>();

// Acquire the append mutex for a path, ref-counting so the entry survives while any writer is
// using it (preserving mutual exclusion) yet is purged once idle (avoids unbounded map growth).
function acquireAppendMutex(key: string): AsyncMutex {
	let entry = appendFileMutexes.get(key);
	if (!entry) {
		entry = { mutex: new AsyncMutex(), refs: 0 };
		appendFileMutexes.set(key, entry);
	}
	entry.refs++;
	return entry.mutex;
}

function releaseAppendMutex(key: string): void {
	const entry = appendFileMutexes.get(key);
	if (!entry) return;
	entry.refs--;
	if (entry.refs <= 0) appendFileMutexes.delete(key);
}

export function appendFileMutexCount(): number {
	return appendFileMutexes.size;
}

export async function appendJsonLine(filePath: string, value: unknown): Promise<void> {
	const file = path.resolve(filePath);
	const mutex = acquireAppendMutex(file);
	try {
		await mutex.runExclusive(async () => {
			await fs.appendFile(file, `${safeJson(value, 0)}\n`, "utf8");
		});
	} finally {
		releaseAppendMutex(file);
	}
}
