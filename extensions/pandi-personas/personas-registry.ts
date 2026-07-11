import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGED_PERSONA_DIRS_SYMBOL = Symbol.for("@pandi-coding-agent/pandi-personas/directories");

type GlobalRegistry = Record<PropertyKey, unknown>;

function personaDirectoryRegistry(): string[] {
	const state = globalThis as GlobalRegistry;
	const current = state[PACKAGED_PERSONA_DIRS_SYMBOL];
	if (Array.isArray(current)) return current as string[];
	const dirs: string[] = [];
	state[PACKAGED_PERSONA_DIRS_SYMBOL] = dirs;
	return dirs;
}

export function registerPersonaDirectory(dir = join(dirname(fileURLToPath(import.meta.url)), "personas")): void {
	const resolved = resolve(dir);
	const dirs = personaDirectoryRegistry();
	if (!dirs.includes(resolved)) dirs.push(resolved);
}
