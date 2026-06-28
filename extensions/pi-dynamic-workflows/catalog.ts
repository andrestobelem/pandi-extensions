/**
 * Workflow pattern catalog metadata + key resolution for dynamic-workflows.
 *
 * Pure data + lookup helpers, split out of templates.ts for cohesion. The
 * executable scaffolds and the embedded-string map stay in templates.ts.
 */

export interface WorkflowPattern {
	key: string;
	title: string;
	blurb: string;
	useWhen: string;
	inputHint: string;
	primitives: string[];
	defaultName: string;
	category?: "template" | "compose" | "use-case";
	useCases?: string[];
}

export const WORKFLOW_PATTERN_CATALOG: WorkflowPattern[] = [
	{
		key: "classify-and-act",
		title: "Classify and act",
		category: "template",
		blurb: "Scout/classify items cheaply, then run targeted follow-ups only for high-signal classes.",
		useWhen: "Many items need different handling after a cheap classifier, such as code audits or migrations.",
		inputHint: '{ "pattern": "\\\\.(ts|tsx|js)$", "maxFiles": 40 }',
		primitives: ["ctx.bash", "ctx.pipeline", "ctx.agent(schema)"],
		defaultName: "classify-and-act",
	},
	{
		key: "fan-out-and-synthesize",
		title: "Fan-out and synthesize",
		category: "template",
		blurb: "Split independent work across agents, then synthesize as a judge with evidence and partial-failure notes.",
		useWhen: "The task has many independent branches and a final merge/synthesis step.",
		inputHint: '{ "limit": 12, "concurrency": 4 }',
		primitives: ["ctx.bash", "ctx.agents(settle)", "ctx.agent"],
		defaultName: "fan-out-and-synthesize",
	},
	{
		key: "adversarial-verification",
		title: "Adversarial verification",
		category: "template",
		blurb: "Launch skeptics per claim/finding and keep only what survives evidence-backed refutation.",
		useWhen: "You have findings, claims, or plans and need confidence before acting on them.",
		inputHint: '{ "findings": [{ "id": "f1", "claim": "..." }], "skeptics": 3 }',
		primitives: ["ctx.parallel", "ctx.agent(schema)", "voting"],
		defaultName: "adversarial-verification",
	},
	{
		key: "generate-and-filter",
		title: "Generate and filter",
		category: "template",
		blurb: "Generate candidates from distinct angles, judge by rubric, and escalate only if confidence is low.",
		useWhen: "You need best-of-N options without trusting one sample or one scalar score.",
		inputHint: '{ "question": "...", "angles": ["risk-first", "simplicity-first"] }',
		primitives: ["ctx.parallel", "ctx.agent(schema)", "adaptive loop"],
		defaultName: "generate-and-filter",
	},
	{
		key: "tournaments",
		title: "Tournaments",
		category: "template",
		blurb: "Generate or accept candidates and run pairwise judging rounds until one winner remains.",
		useWhen: "You need comparative ranking, not just independent scoring.",
		inputHint: '{ "topic": "...", "angles": ["cost", "quality", "risk"] }',
		primitives: ["ctx.agents(settle)", "ctx.agent(schema)", "bracket"],
		defaultName: "tournaments",
	},
	{
		key: "loop-until-done",
		title: "Loop until done",
		category: "template",
		blurb: "Repeat discovery or repair rounds until no new findings remain or a hard stop condition fires.",
		useWhen:
			"The work-list size is unknown and progress should stop on quiet rounds, max rounds, budget, or timeout.",
		inputHint: '{ "finders": 3, "quietRounds": 2, "maxRounds": 8 }',
		primitives: ["ctx.agents(settle)", "loop", "ctx.log"],
		defaultName: "loop-until-done",
	},
	{
		key: "compose-verify-claims",
		title: "Compose: verify claims",
		category: "compose",
		blurb: "Discover claims/items, then delegate reusable verification to ctx.workflow('lib/verify-claims').",
		useWhen:
			"Discovery and reusable verification can run in one parent workflow without a decision gate between them.",
		inputHint: '{ "topic": "claims to discover and verify" }',
		primitives: ["ctx.workflow", "ctx.agent", "sub-workflow"],
		defaultName: "compose-verify-claims",
	},
	{
		key: "lib-verify-claims",
		title: "Lib: verify claims",
		category: "compose",
		blurb: "Reusable sub-workflow contract: { claims, skeptics? } -> verified/dropped claims with evidence.",
		useWhen: "You want a shared library workflow under lib/ that parent workflows call with ctx.workflow().",
		inputHint: '{ "claims": [{ "id": "c1", "claim": "..." }] }',
		primitives: ["ctx.agents(settle)", "ctx.agent(schema)", "library contract"],
		defaultName: "lib/verify-claims",
	},
	{
		key: "workflow-factory",
		title: "Workflow factory",
		category: "compose",
		blurb: "Meta-workflow that designs prompts/contracts, generates a task-specific draft, and reviews it.",
		useWhen: "A warranted workflow needs complex prompt/contract design before spending many subagents.",
		inputHint: '{ "task": "audit this repo for race conditions", "write": true }',
		primitives: ["ctx.agent(schema)", "prompt improvement", "ctx.writeFile"],
		defaultName: "workflow-factory",
	},
	{
		key: "bug-hunt-repo-audit",
		title: "Bug hunt / repo audit",
		category: "use-case",
		blurb: "Scout code files, fan out reviewer agents, and synthesize prioritized bugs with citations.",
		useWhen: "You want a reusable broad bug-hunt workflow rather than a one-off generated audit.",
		inputHint: '{ "maxFiles": 40, "concurrency": 4 }',
		primitives: ["ctx.bash", "ctx.agents(settle)", "reviewer synthesis"],
		defaultName: "bug-hunt-repo-audit",
	},
	{
		key: "large-migration",
		title: "Large migration",
		category: "use-case",
		blurb: "Scout and classify files, then target migration review/work only where the classifier says it matters.",
		useWhen: "A migration spans many files and needs capped, evidence-backed coverage before implementation.",
		inputHint: '{ "pattern": "\\\\.(ts|tsx|js)$", "maxFiles": 80 }',
		primitives: ["ctx.bash", "ctx.pipeline", "ctx.agent(schema)"],
		defaultName: "large-migration",
	},
	{
		key: "complex-research",
		title: "Complex research",
		category: "use-case",
		blurb: "Run independent research angles, then synthesize with citations/evidence and coverage notes.",
		useWhen: "You need broad source-backed research, migration analysis, or vendor/architecture comparison.",
		inputHint: '{ "question": "...", "angles": ["docs", "risks", "alternatives"] }',
		primitives: ["ctx.agents(settle)", "research angles", "synthesis-as-judge"],
		defaultName: "complex-research",
	},
	{
		key: "plan-review",
		title: "Plan review",
		category: "use-case",
		blurb: "Review a plan from multiple skeptical perspectives and synthesize accepted risks and fixes.",
		useWhen: "Before implementing a risky plan, migration, or architecture change.",
		inputHint: '{ "plan": "...", "perspectives": ["security", "performance"] }',
		primitives: ["ctx.agents(settle)", "reviewer panel", "synthesis-as-judge"],
		defaultName: "plan-review",
	},
	{
		key: "claim-bug-verification",
		title: "Claim/bug verification",
		category: "use-case",
		blurb: "Verify suspected bugs or factual claims with independent skeptics before reporting or acting.",
		useWhen: "A previous sweep produced claims/findings that need evidence-backed pruning.",
		inputHint: '{ "findings": [{ "id": "f1", "claim": "..." }], "skeptics": 3 }',
		primitives: ["ctx.parallel", "ctx.agent(schema)", "voting"],
		defaultName: "claim-bug-verification",
	},
];

const WORKFLOW_PATTERN_USE_CASES: Record<string, string[]> = {
	"classify-and-act": [
		"Audit only files that a cheap classifier marks medium/high risk",
		"Review a PR by touched files with deeper follow-up only where needed",
		"Migrate a codebase by classifying files before targeted action",
	],
	"fan-out-and-synthesize": [
		"Split a docs audit by file and synthesize",
		"Run independent reviewers over a capped work-list",
		"Prototype a one-off generated workflow under <slug>",
	],
	"adversarial-verification": [
		"Verify suspected bugs before filing them",
		"Have skeptics refute a migration plan",
		"Drop hallucinated findings from a previous broad sweep",
	],
	"generate-and-filter": [
		"Generate several implementation strategies and keep the best",
		"Pick between architecture options by rubric",
		"Improve a prompt by trying variants and judging confidence",
	],
	tournaments: [
		"Rank candidate designs pairwise",
		"Choose the best generated prompt/template",
		"Compare multiple remediation plans without relying on one scalar score",
	],
	"loop-until-done": [
		"Keep searching for security issues until quiet rounds",
		"Discover unknown call sites or migration blockers",
		"Run repair/verify rounds until green or capped",
	],
	"compose-verify-claims": [
		"Use ctx.workflow('lib/verify-claims') as a reusable verification phase",
		"Separate discovery from reusable claim verification",
		"Demonstrate parent/child workflow composition",
	],
	"lib-verify-claims": [
		"Reusable sub-workflow for fact-checking claims",
		"Shared verifier called by multiple generated workflows",
		"Teach lib/ convention for composable workflow building blocks",
	],
	"workflow-factory": [
		"Given a user task, design a custom <slug> workflow",
		"Improve prompts/contracts before spending many subagents",
		"Produce a reusable workflow scaffold plus review notes as artifacts",
	],
	"bug-hunt-repo-audit": [
		"Find likely bugs across many repo files",
		"Run reviewer agents by file chunk",
		"Produce prioritized findings with citations",
	],
	"large-migration": [
		"Classify migration files by risk",
		"Find migration blockers before editing",
		"Plan a broad API/package migration with visible caps",
	],
	"complex-research": [
		"Research a migration or vendor choice with independent angles",
		"Collect and synthesize source-backed options",
		"Compare alternatives before implementation",
	],
	"plan-review": [
		"Review an implementation plan from security/performance/product angles",
		"Find reasons not to execute a proposed migration",
		"Get a skeptical panel before committing code",
	],
	"claim-bug-verification": [
		"Verify suspected bugs before reporting",
		"Check claims from a previous sweep",
		"Separate true findings from unsupported suspicions",
	],
};

function normalizePatternKey(key: string): string {
	return key
		.trim()
		.toLowerCase()
		.replace(/^adaptive-/, "")
		.replace(/\.(js|mjs|cjs)$/i, "");
}

export function resolveWorkflowPattern(key: string | undefined): WorkflowPattern | undefined {
	if (!key) return undefined;
	const normalized = normalizePatternKey(key);
	return WORKFLOW_PATTERN_CATALOG.find((pattern) => pattern.key === normalized);
}

export function getPatternUseCases(pattern: WorkflowPattern): string[] {
	return pattern.useCases ?? WORKFLOW_PATTERN_USE_CASES[pattern.key] ?? [];
}
