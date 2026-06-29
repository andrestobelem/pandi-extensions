/**
 * Workflow pattern catalog and embedded scaffolds for dynamic-workflows.
 *
 * Keep these templates self-contained in the package so runtime template lookup does
 * not depend on examples/ or any project-local files being present.
 */

import { WORKFLOW_PATTERN_CATALOG } from "./catalog.js";
import type { WorkflowPattern } from "./catalog.js";
import { EMBEDDED_SCAFFOLD_SOURCES } from "./scaffolds.generated.js";

export {
	getPatternUseCases,
	resolveWorkflowPattern,
	WORKFLOW_PATTERN_CATALOG,
} from "./catalog.js";
export type { WorkflowPattern } from "./catalog.js";
export {
	formatWorkflowCompositionPromptGuidance,
	formatWorkflowCompositionPromptSummary,
	formatWorkflowPatternCatalog,
	formatWorkflowPatternKeyList,
	formatWorkflowPatternPromptCheatSheet,
} from "./pattern-format.js";

export const WORKFLOW_TEMPLATE = EMBEDDED_SCAFFOLD_SOURCES.default;

// The executable scaffolds live as real files under scaffolds/*.js and are inlined
// into EMBEDDED_SCAFFOLD_SOURCES by scripts/gen-scaffolds.mjs (npm run generate), so
// the code ships inside the package as data with no runtime filesystem dependency.
const EMBEDDED_WORKFLOW_PATTERN_TEMPLATES: Record<string, string> = {
	"scout-fanout": EMBEDDED_SCAFFOLD_SOURCES["scout-fanout"],
	"loop-until-dry": EMBEDDED_SCAFFOLD_SOURCES["loop-until-dry"],
	"adversarial-verify": EMBEDDED_SCAFFOLD_SOURCES["adversarial-verify"],
	"judge-escalate": EMBEDDED_SCAFFOLD_SOURCES["judge-escalate"],
	tournament: EMBEDDED_SCAFFOLD_SOURCES.tournament,
	"workflow-factory": EMBEDDED_SCAFFOLD_SOURCES["workflow-factory"],
	"composition-driver": EMBEDDED_SCAFFOLD_SOURCES["composition-driver"],
	"verify-claims-lib": EMBEDDED_SCAFFOLD_SOURCES["verify-claims-lib"],
	"complex-research": EMBEDDED_SCAFFOLD_SOURCES["complex-research"],
	"repo-bug-hunt": EMBEDDED_SCAFFOLD_SOURCES["repo-bug-hunt"],
	"adversarial-plan-review": EMBEDDED_SCAFFOLD_SOURCES["adversarial-plan-review"],
};

EMBEDDED_WORKFLOW_PATTERN_TEMPLATES["classify-and-act"] = EMBEDDED_WORKFLOW_PATTERN_TEMPLATES["scout-fanout"];
EMBEDDED_WORKFLOW_PATTERN_TEMPLATES["fan-out-and-synthesize"] = WORKFLOW_TEMPLATE;
EMBEDDED_WORKFLOW_PATTERN_TEMPLATES["adversarial-verification"] =
	EMBEDDED_WORKFLOW_PATTERN_TEMPLATES["adversarial-verify"];
EMBEDDED_WORKFLOW_PATTERN_TEMPLATES["generate-and-filter"] = EMBEDDED_WORKFLOW_PATTERN_TEMPLATES["judge-escalate"];
EMBEDDED_WORKFLOW_PATTERN_TEMPLATES.tournaments = EMBEDDED_WORKFLOW_PATTERN_TEMPLATES.tournament;
EMBEDDED_WORKFLOW_PATTERN_TEMPLATES["loop-until-done"] = EMBEDDED_WORKFLOW_PATTERN_TEMPLATES["loop-until-dry"];
EMBEDDED_WORKFLOW_PATTERN_TEMPLATES["compose-verify-claims"] =
	EMBEDDED_WORKFLOW_PATTERN_TEMPLATES["composition-driver"];
EMBEDDED_WORKFLOW_PATTERN_TEMPLATES["lib-verify-claims"] = EMBEDDED_WORKFLOW_PATTERN_TEMPLATES["verify-claims-lib"];
EMBEDDED_WORKFLOW_PATTERN_TEMPLATES["bug-hunt-repo-audit"] = EMBEDDED_WORKFLOW_PATTERN_TEMPLATES["repo-bug-hunt"];
EMBEDDED_WORKFLOW_PATTERN_TEMPLATES["large-migration"] = EMBEDDED_WORKFLOW_PATTERN_TEMPLATES["scout-fanout"];
EMBEDDED_WORKFLOW_PATTERN_TEMPLATES["plan-review"] = EMBEDDED_WORKFLOW_PATTERN_TEMPLATES["adversarial-plan-review"];
EMBEDDED_WORKFLOW_PATTERN_TEMPLATES["claim-bug-verification"] =
	EMBEDDED_WORKFLOW_PATTERN_TEMPLATES["adversarial-verify"];

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
