/**
 * Workflow pattern catalog and embedded scaffolds for dynamic-workflows.
 *
 * Keep these templates self-contained in the package so runtime template lookup does
 * not depend on examples/ or any project-local files being present.
 */

import type { WorkflowPattern } from "./catalog.js";
import { WORKFLOW_PATTERN_CATALOG } from "./catalog.js";
import { EMBEDDED_SCAFFOLD_SOURCES } from "./scaffolds.generated.js";

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

// Default template served by `/workflow new` (no --pattern) and the Patterns tab: the
// base scatter-gather pattern.
export const WORKFLOW_TEMPLATE = EMBEDDED_SCAFFOLD_SOURCES["fan-out-and-synthesize"];

// The executable scaffolds live as real files under scaffolds/*.js and are inlined into
// EMBEDDED_SCAFFOLD_SOURCES by scripts/gen-scaffolds.mjs (npm run generate), so the code ships
// inside the package as data with no runtime filesystem dependency. Catalog keys ARE the scaffold
// names, so every pattern maps 1:1 to its embedded source (no aliases) and the orphan invariant
// below is trivially satisfied.
const EMBEDDED_WORKFLOW_PATTERN_TEMPLATES: Record<string, string> = Object.fromEntries(
	WORKFLOW_PATTERN_CATALOG.map((pattern) => [pattern.key, EMBEDDED_SCAFFOLD_SOURCES[pattern.key]]),
);

export async function loadWorkflowPatternCode(pattern: WorkflowPattern): Promise<string> {
	const template = EMBEDDED_WORKFLOW_PATTERN_TEMPLATES[pattern.key];
	if (template === undefined) {
		throw new Error(`Embedded workflow template missing for pattern ${pattern.key}`);
	}
	return template;
}

// An embedded scaffold is only reachable when a catalog pattern's key maps to its code
// (directly or via the alias assignments above). Any embedded scaffold served by no catalog
// pattern is dead code; this invariant keeps new orphans from creeping in.
export function listOrphanedTemplateKeys(): string[] {
	const reachable = new Set<string>();
	for (const pattern of WORKFLOW_PATTERN_CATALOG) {
		const code = EMBEDDED_WORKFLOW_PATTERN_TEMPLATES[pattern.key];
		if (code !== undefined) reachable.add(code);
	}
	return Object.entries(EMBEDDED_WORKFLOW_PATTERN_TEMPLATES)
		.filter(([, code]) => !reachable.has(code))
		.map(([key]) => key)
		.sort();
}
