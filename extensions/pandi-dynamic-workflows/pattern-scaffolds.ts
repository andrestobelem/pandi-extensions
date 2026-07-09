/**
 * Catálogo de patrones de workflow y fuentes de scaffolds para dynamic-workflows.
 *
 * Los scaffolds ejecutables se escriben como archivos reales bajo scaffolds/*.js y se leen de disco
 * lazy en el primer uso (relativos a este módulo vía import.meta.url) — así que los archivos .js SON el
 * artifact publicado: sin codegen, sin copia derivada, tested == shipped por construcción. La lectura es
 * lazy (no en import time), así que solo cargar la extensión nunca toca el filesystem; solo lo hace un
 * pedido real de scaffold (esto mantiene funcionando cargas bundled/reubicadas que nunca sirven un scaffold).
 * package.json files[] incluye el directorio scaffolds/ y pi carga la extensión como fuente on-disk,
 * así que el lookup sibling vale tanto en dev como en layouts instalados.
 */

import { readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { WorkflowPattern } from "./catalog.js";
import { WORKFLOW_PATTERN_CATALOG } from "./catalog.js";

const SCAFFOLDS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "scaffolds");

let scaffoldSourcesCache: Record<string, string> | null = null;
// Leé cada scaffolds/<key>.js en un map nombre->fuente, una vez y lazy (cacheado). El IO sync está
// bien: corre como máximo una vez sobre ~25 archivos chicos, y solo cuando se pide el primer scaffold.
function scaffoldSources(): Record<string, string> {
	if (scaffoldSourcesCache) return scaffoldSourcesCache;
	const map: Record<string, string> = {};
	for (const file of readdirSync(SCAFFOLDS_DIR)) {
		if (file.endsWith(".js")) map[file.slice(0, -3)] = readFileSync(path.join(SCAFFOLDS_DIR, file), "utf8");
	}
	scaffoldSourcesCache = map;
	return map;
}

export type { WorkflowPattern } from "./catalog.js";
export {
	getPatternUseCases,
	resolveWorkflowPattern,
	WORKFLOW_PATTERN_CATALOG,
} from "./catalog.js";
export {
	formatWorkflowCompositionPromptGuidance,
	formatWorkflowCompositionPromptSummary,
	formatWorkflowPatternCatalog,
	formatWorkflowPatternKeyList,
	formatWorkflowPatternPromptCheatSheet,
} from "./pattern-format.js";

// Scaffold default servido por `/workflow new` (sin --pattern) y el tab Patterns: el patrón base
// scatter-gather. Es función (no const) para que la lectura de disco siga lazy.
export function getDefaultScaffold(): string {
	return scaffoldSources()["fan-out-and-synthesize"];
}

function scaffoldSourceFor(pattern: WorkflowPattern): string {
	// Las claves del catálogo SON los filenames de scaffold (1:1, sin aliases), así que la clave mapea a scaffolds/<key>.js.
	const scaffold = scaffoldSources()[pattern.key];
	if (scaffold === undefined) {
		throw new Error(`Workflow scaffold missing for pattern ${pattern.key} (expected scaffolds/${pattern.key}.js)`);
	}
	return scaffold;
}

/** Ruta predecible del asset canónico para una clave ya validada por el catálogo. */
export function getWorkflowPatternPath(pattern: WorkflowPattern): string {
	return path.join(SCAFFOLDS_DIR, `${pattern.key}.js`);
}

export async function loadWorkflowPatternCode(pattern: WorkflowPattern): Promise<string> {
	return scaffoldSourceFor(pattern);
}

// Un patrón de catálogo mapea 1:1 a scaffolds/<key>.js. Este guard mantiene el map por clave de catálogo libre de
// entradas muertas; el chequeo completo de huérfanos (un scaffolds/*.js sin clave de catálogo) vive en el
// test de integración de composición, que lee todo el directorio.
export function listOrphanedScaffoldKeys(): string[] {
	const sources = scaffoldSources();
	const patternScaffolds: Record<string, string> = Object.fromEntries(
		WORKFLOW_PATTERN_CATALOG.map((pattern) => [pattern.key, sources[pattern.key]]),
	);
	const reachable = new Set<string>();
	for (const pattern of WORKFLOW_PATTERN_CATALOG) {
		const code = patternScaffolds[pattern.key];
		if (code !== undefined) reachable.add(code);
	}
	return Object.entries(patternScaffolds)
		.filter(([, code]) => !reachable.has(code))
		.map(([key]) => key)
		.sort();
}
