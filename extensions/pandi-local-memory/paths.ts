// pi-local-memory path helpers + a tolerant file read. Pure; index.ts stays wiring-only
// and imports these. The folder/index file names come from ./memory.ts so the layout is
// defined in exactly one place.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { INDEX_FILE, MEMORY_DIR } from "./memory.js";

/** `<configDir>/memory/` folder that holds the injected index plus on-demand topic files. */
export function memoryDirOf(cwd: string): string {
	return join(cwd, CONFIG_DIR_NAME, MEMORY_DIR);
}
/** `<configDir>/memory/MEMORY.md` — the entrypoint injected at startup. */
export function indexPathOf(cwd: string): string {
	return join(memoryDirOf(cwd), INDEX_FILE);
}
/** Pre-folder location; still read as a fallback / migration source. */
export function legacyPathOf(cwd: string): string {
	return join(cwd, CONFIG_DIR_NAME, "MEMORY.md");
}

/** Read a file as text, or null when absent OR unreadable (EISDIR/EACCES/TOCTOU). */
export function safeRead(path: string): string | null {
	try {
		if (!existsSync(path)) return null;
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
}
