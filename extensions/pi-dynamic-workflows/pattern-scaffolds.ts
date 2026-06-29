/**
 * Workflow pattern catalog and scaffold sources for dynamic-workflows.
 *
 * The executable scaffolds are authored as real files under scaffolds/*.js and read from disk
 * lazily on first use (relative to this module via import.meta.url) — so the .js files ARE the
 * shipped artifact: no codegen, no derived copy, tested == shipped by construction. The read is
 * lazy (not at import time) so merely loading the extension never touches the filesystem; only an
 * actual scaffold request does (this keeps bundled/relocated loads that never serve a scaffold
 * working). package.json files[] ships the scaffolds/ directory and pi loads the extension as
 * on-disk source, so the sibling lookup holds in both dev and installed layouts.
 */

import { readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { WorkflowPattern } from "./catalog.js";
import { WORKFLOW_PATTERN_CATALOG } from "./catalog.js";

const SCAFFOLDS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "scaffolds");

let scaffoldSourcesCache: Record<string, string> | null = null;
// Read every scaffolds/<key>.js into a name->source map, once and lazily (cached). Sync IO is
// fine: it runs at most once over ~25 tiny files, and only when a scaffold is first requested.
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

// Default scaffold served by `/workflow new` (no --pattern) and the Patterns tab: the base
// scatter-gather pattern. A function (not a const) so the disk read stays lazy.
export function getDefaultScaffold(): string {
	return scaffoldSources()["fan-out-and-synthesize"];
}

export async function loadWorkflowPatternCode(pattern: WorkflowPattern): Promise<string> {
	// Catalog keys ARE the scaffold filenames (1:1, no aliases), so the key maps to scaffolds/<key>.js.
	const scaffold = scaffoldSources()[pattern.key];
	if (scaffold === undefined) {
		throw new Error(`Workflow scaffold missing for pattern ${pattern.key} (expected scaffolds/${pattern.key}.js)`);
	}
	return scaffold;
}

// A catalog pattern maps 1:1 to scaffolds/<key>.js. This guard keeps the catalog-keyed map free of
// dead entries; the full orphan check (a scaffolds/*.js with no catalog key) lives in the
// composition integration test, which reads the whole directory.
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
