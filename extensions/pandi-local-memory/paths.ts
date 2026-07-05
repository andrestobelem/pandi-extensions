// Helpers de paths de pandi-local-memory + lectura tolerante de archivos. Puras; index.ts conserva solo la orquestación
// e importa esto. Los nombres de carpeta/índice vienen de ./memory.ts, así que la estructura queda
// definida en un solo lugar.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { INDEX_FILE, MEMORY_DIR } from "./memory.js";

/** Carpeta `<configDir>/memory/` que guarda el índice inyectado y los archivos de topic bajo demanda. */
export function memoryDirOf(cwd: string): string {
	return join(cwd, CONFIG_DIR_NAME, MEMORY_DIR);
}
/** `<configDir>/memory/MEMORY.md` — el punto de entrada que se inyecta al inicio. */
export function indexPathOf(cwd: string): string {
	return join(memoryDirOf(cwd), INDEX_FILE);
}
/** Ubicación previa a la carpeta; se sigue leyendo como fuente de fallback/migración. */
export function legacyPathOf(cwd: string): string {
	return join(cwd, CONFIG_DIR_NAME, "MEMORY.md");
}

/** Lee un archivo como texto, o null si falta O no se puede leer (EISDIR/EACCES/TOCTOU). */
export function safeRead(path: string): string | null {
	try {
		if (!existsSync(path)) return null;
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
}
