// Instantáneas de compactación recuperable de pandi-auto-compact: las entradas sin procesar que están por
// resumirse se guardan ANTES de que el resumen con pérdida las reemplace, así la compactación es
// recuperable en vez de destructiva. Las instantáneas viven en <cwd>/<configDir>/<SNAPSHOT_DIR>/
// <sessionId>/ (gitignored) — deliberadamente NO en la carpeta de memory, que es para hechos curados,
// inyectados, no para transcripciones sin procesar voluminosas. Helpers puros de ruta/forma/poda; se reexportan
// desde index.ts para que el bundle compilado siga exportando los nombres que usa la suite de integración.

import { join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

const SNAPSHOT_DIR = "compaction-snapshots";

// Reemplaza cualquier cosa fuera de un conjunto seguro de nombres de archivo para que session id / timestamp / reason
// nunca puedan escapar del directorio de instantáneas. Se recortan los `._-` iniciales/finales y un
// resultado de solo puntos (p. ej. "." o "..", que atravesaría directorios) vuelve a `fallback`.
const safeSegment = (raw: string, fallback: string): string => {
	const cleaned = (raw ?? "").replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[._-]+|[._-]+$/g, "");
	return cleaned && !/^\.+$/.test(cleaned) ? cleaned : fallback;
};

/** Directorio de instantáneas por sesión: <cwd>/<configDir>/compaction-snapshots/<sessionId>/. Puro. */
export const snapshotDirFor = (cwd: string, sessionId: string): string =>
	join(cwd, CONFIG_DIR_NAME, SNAPSHOT_DIR, safeSegment(sessionId, "session"));

/** Nombre del archivo de instantánea. Con prefijo de timestamp para que un sort lexicográfico sea cronológico. Puro. */
export const snapshotFileName = (createdAtIso: string, reason: string, sequence = 0): string => {
	const suffix = sequence > 0 ? `-${sequence}` : "";
	return `${safeSegment(createdAtIso, "snapshot")}-${safeSegment(reason, "compact")}${suffix}.json`;
};

export interface CompactionSnapshot {
	version: 1;
	sessionId: string;
	createdAt: string;
	reason: string;
	willRetry: boolean;
	entryCount: number;
	entries: unknown[];
	/** El resumen con pérdida que reemplazó a `entries`, aplicado después de que termina la compactación. */
	summary?: string;
}

/** Construye el objeto de instantánea serializable a partir de las entradas sin procesar que se están compactando. Puro. */
export const buildSnapshot = (opts: {
	sessionId: string;
	createdAt: string;
	reason: string;
	willRetry: boolean;
	entries: unknown[];
}): CompactionSnapshot => {
	const entries = Array.isArray(opts.entries) ? opts.entries : [];
	return {
		version: 1,
		sessionId: opts.sessionId,
		createdAt: opts.createdAt,
		reason: opts.reason,
		willRetry: opts.willRetry,
		entryCount: entries.length,
		entries,
	};
};

// Dado un conjunto de nombres de archivos de instantáneas (en cualquier orden), devuelve los MÁS ANTIGUOS más allá de `keep`.
// Los nombres tienen prefijo de timestamp, así que un sort lexicográfico es cronológico. keep<=0 poda todo.
// Los archivos de instantánea en un listado de directorio: solo .json, del más antiguo al más nuevo (sort léxico ==
// cronológico porque los nombres tienen prefijo de timestamp). Lo comparten la selección para poda y el listado
// `snapshots` para que ambos definan "un archivo de instantánea" de forma idéntica.
export const sortedSnapshotNames = (fileNames: string[]): string[] =>
	fileNames.filter((n) => n.endsWith(".json")).sort();

export const selectSnapshotsToPrune = (fileNames: string[], keep: number): string[] => {
	const snaps = sortedSnapshotNames(fileNames);
	if (keep <= 0) return snaps;
	return snaps.slice(0, Math.max(0, snaps.length - keep));
};
