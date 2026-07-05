/**
 * Append serializado a archivo JSONL — un AsyncMutex por path para que writers concurrentes al mismo
 * archivo events/journal nunca intercalen una línea parcial. Una hoja usada por el engine
 * (events.jsonl) y journal.ts (el journal de cache de runs reanudables).
 *
 * Extraído byte-idéntico desde index.ts.
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

// Adquirí el mutex de append para un path, con ref-count para que la entrada sobreviva mientras cualquier writer
// la usa (preservando la exclusión mutua) pero se purgue al quedar idle (evita crecimiento no acotado del map).
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
