/**
 * Presentation helpers that render the workflow pattern catalog into the
 * prompt/cheat-sheet strings shown to humans and the model. Split out of
 * templates.ts for cohesion; pure formatters over catalog.ts data.
 */

import type { WorkflowPattern } from "./catalog.js";
import { getPatternUseCases, WORKFLOW_PATTERN_CATALOG } from "./catalog.js";

export function formatWorkflowPatternCatalog(patterns = WORKFLOW_PATTERN_CATALOG): string {
	const lines = [
		"Workflow pattern catalog",
		"Use in TUI: /workflows → Patterns tab, then Enter/n to create a project workflow draft.",
		"Use from command line: /workflow new <name> --pattern=<key>",
		"Use from tool: dynamic_workflow action=template name=<key>",
		"",
	];
	const sections: [WorkflowPattern["category"], string][] = [
		["template", "Templates"],
		["compose", "Compose templates"],
		["use-case", "Use-case templates"],
	];
	for (const [category, label] of sections) {
		const sectionPatterns = patterns.filter((pattern) => (pattern.category ?? "template") === category);
		if (sectionPatterns.length === 0) continue;
		lines.push(`## ${label}`, "");
		for (const pattern of sectionPatterns) {
			const useCases = getPatternUseCases(pattern);
			lines.push(`- ${pattern.key} — ${pattern.title}`);
			lines.push(`  ${pattern.blurb}`);
			lines.push(`  When: ${pattern.useWhen}`);
			if (useCases.length) lines.push(`  Use cases: ${useCases.slice(0, 3).join("; ")}`);
			lines.push(`  Input: ${pattern.inputHint}`);
			lines.push(`  Primitives: ${pattern.primitives.join(", ")}`);
		}
		lines.push("");
	}
	lines.push(
		"## Research-backed templates",
		"",
		"Map common agent papers/frameworks to Pi workflow design:",
		"",
		"- **ReAct** -> scout/observe with tools before fan-out; keep reasoning tied to evidence.",
		"- **Self-consistency** -> sample independent branches, then select by consistency/evidence rather than trusting one path.",
		"- **Reflexion / Self-Refine** -> generate -> critique -> refine loops, always bounded by rounds, quiet stops, `maxAgents`, and timeout.",
		"- **Tree of Thoughts** -> branch alternatives, evaluate/prune with a judge, then commit to one path.",
		"- **Multiagent debate** -> adversarial reviewers plus synthesis-as-judge; unsupported claims are dropped.",
		"- **AutoGen / CAMEL / MetaGPT** -> explicit roles, stable artifacts, and clear handoff contracts.",
		"- **SWE-agent / DSPy** -> interface and contracts matter: narrow tools, schemas/fixed formats, and reproducible checks.",
		"",
		"Use these as patterns, not ceremony: every branch needs a reason, a contract, and a stop condition.",
	);
	return lines.join("\n").trimEnd();
}

export function formatWorkflowPatternPromptCheatSheet(patterns = WORKFLOW_PATTERN_CATALOG): string {
	const lines = [
		"Workflow template catalog (choose from these before writing from scratch; inspect with dynamic_workflow action=template, fetch a scaffold with name=<key>):",
	];
	for (const pattern of patterns) {
		lines.push(`- ${pattern.key}: ${pattern.useWhen} Primitives: ${pattern.primitives.join(", ")}.`);
	}
	return lines.join("\n");
}

export function formatWorkflowCompositionPromptGuidance(): string {
	return [
		"Workflow composition rules:",
		'- Use workflow("lib/<name>", args) for a reusable sub-step with no human/agent decision gate between parent and child; keep one shared run, concurrency pool, maxAgents budget, abort signal, runDir, and resume/cache journal.',
		"- Store reusable contracts under lib/<name>.js, accept one args object, validate inputs, return stable JSON-serializable results, and document the contract in a header comment.",
		"- Depth is 1: a sub-workflow must not call workflow() again; if the next phase depends on inspecting child output, run separate workflows sequentially and inspect artifacts between runs.",
		'- Prefer compose-verify-claims plus lib-verify-claims as the reference pattern for discovery -> reusable verification; graph literal workflow("...") calls when reviewing structure.',
	].join("\n");
}

export function formatWorkflowPatternKeyList(patterns = WORKFLOW_PATTERN_CATALOG): string {
	const keys = patterns.map((pattern) => pattern.key).join(", ");
	return `Workflow templates: ${keys}. Inspect details with dynamic_workflow action=template; fetch a scaffold with name=<key>.`;
}

export function formatWorkflowCompositionPromptSummary(): string {
	return 'Composition: use workflow("lib/<name>", args) only for reusable sub-steps with no decision gate; depth is 1; inspect child output in a separate workflow run before changing course.';
}
