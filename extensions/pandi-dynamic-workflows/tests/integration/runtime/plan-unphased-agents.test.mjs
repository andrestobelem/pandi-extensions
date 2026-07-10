#!/usr/bin/env node
/**
 * workflow-plan-unphased-agents — regression for #64.
 *
 * The static Plan tab must not hide agents declared without an explicit phase.
 * `extract.mjs` stamps those nodes with the sentinel "—"; the phase renderer must
 * keep that bucket instead of treating it as empty.
 */

import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createChecker } from "../../../../shared/test/harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..", "..");
const PLAN_LIB = path.join(REPO_ROOT, ".claude", "scripts", "lib", "plan.mjs");

const { renderWorkflowPlan } = await import(pathToFileURL(PLAN_LIB).href);
const { check, counts } = createChecker();

function sectionBetween(html, startNeedle, endNeedle) {
	const start = html.indexOf(startNeedle);
	if (start < 0) return "";
	const end = html.indexOf(endNeedle, start + startNeedle.length);
	return end < 0 ? html.slice(start) : html.slice(start, end);
}

const unphasedHtml = renderWorkflowPlan({
	meta: { name: "unphased-probe", description: "Probe unphased agents" },
	phases: [],
	nodes: [
		{
			id: "reviewer",
			role: "reviewer",
			phase: "—",
			schema: "object schema",
			model: "sonnet",
			effort: "medium",
		},
	],
});
const unphasedSection = sectionBetween(
	unphasedHtml,
	'<div class="subh">Fases</div>',
	'<div class="subh">Agentes y contratos</div>',
);

check(
	"unphased Plan tab renders a phase card for the sentinel bucket",
	unphasedSection.includes('<span class="nid">—</span>'),
	unphasedSection,
);
check(
	"unphased Plan tab lists the unphased agent in that phase",
	unphasedSection.includes("reviewer"),
	unphasedSection,
);
check(
	"unphased Plan tab does not claim there are no phases",
	!unphasedSection.includes("Sin fases detectadas"),
	unphasedSection,
);

const mixedHtml = renderWorkflowPlan({
	meta: { name: "mixed-probe" },
	phases: ["Scout"],
	nodes: [
		{ id: "scout", role: "scout", phase: "Scout" },
		{ id: "judge", role: "judge", phase: "—" },
	],
});
const mixedSection = sectionBetween(
	mixedHtml,
	'<div class="subh">Fases</div>',
	'<div class="subh">Agentes y contratos</div>',
);

check("mixed Plan tab keeps declared phases", mixedSection.includes('<span class="nid">Scout</span>'), mixedSection);
check(
	"mixed Plan tab also keeps unphased sentinel bucket",
	mixedSection.includes('<span class="nid">—</span>'),
	mixedSection,
);
check("mixed Plan tab lists the unphased agent", mixedSection.includes("judge"), mixedSection);

if (counts.failed > 0) {
	console.error("\nFailures:");
	for (const failure of counts.failures) console.error(`- ${failure}`);
	process.exit(1);
}
console.log(`\n${counts.passed} checks passed`);
