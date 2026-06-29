/**
 * Workflow pattern catalog metadata + key resolution for dynamic-workflows.
 *
 * Pure data + lookup helpers, split out of pattern-scaffolds.ts for cohesion. Catalog keys ARE the
 * scaffold filenames / `meta.name` of extensions/pi-dynamic-workflows/scaffolds/*.js, so
 * pattern-scaffolds.ts maps each key 1:1 to its embedded source. Content mirrors the authoring
 * reference in scaffolds/README.md (§6 "the 25 workflows by family").
 */

export interface WorkflowPattern {
	key: string;
	title: string;
	blurb: string;
	useWhen: string;
	inputHint: string;
	primitives: string[];
	defaultName: string;
	category?: "scaffold" | "compose" | "use-case";
	useCases?: string[];
}

export const WORKFLOW_PATTERN_CATALOG: WorkflowPattern[] = [
	// ── Gate & guard / route & orchestrate / compose & meta (category: compose | use-case) ──
	{
		key: "contract-gate",
		title: "Contract gate (Phase 0)",
		category: "use-case",
		blurb: "Turn a vague ask into an inspectable contract and decide ask-now vs proceed-on-a-recorded-assumption.",
		useWhen: "The ask is vague or high-stakes and you want ask-vs-proceed decided before routing or building.",
		inputHint: '{ "request": "...", "reviewers": 3, "improvePrompt": true }',
		primitives: ["agent(schema)", "parallel", "workflow"],
		defaultName: "contract-gate",
		useCases: ["Scope a fuzzy ticket", "Gate before a costly multi-agent run", "Rewrite a raw ask into a clean spec"],
	},
	{
		key: "guardrails",
		title: "Guardrails (tripwire)",
		category: "compose",
		blurb: "Cheap input/output tripwire that HALTS on a clear violation; can wrap any workflow via protect:{name,args}.",
		useWhen: "You must enforce hard limits cheaply around a run, or validate one artifact.",
		inputHint: '{ "outputRules": ["no secrets in output"], "content": "..." }',
		primitives: ["agent(schema)", "workflow", "fail-closed"],
		defaultName: "guardrails",
		useCases: [
			"Scope/safety gate before running an agent",
			"PII/secret check on an output",
			"Wrap a chosen workflow with input/output tripwires",
		],
	},
	{
		key: "router",
		title: "Router (dispatch)",
		category: "compose",
		blurb: "Classify a request and dispatch to the single best catalog workflow, or recommend-only.",
		useWhen: "You don't want to name the workflow yourself.",
		inputHint: '{ "request": "...", "runSelected": true }',
		primitives: ["agent(schema)", "workflow", "dispatch"],
		defaultName: "router",
		useCases: [
			"A single front door for raw tasks",
			"Preview the pick with runSelected:false",
			"Map a task to the right specialist",
		],
	},
	{
		key: "orchestrator-workers",
		title: "Orchestrator + workers",
		category: "compose",
		blurb: "A planner decomposes an open goal into a dependsOn subtask graph; workers execute level-by-level; an integrator merges.",
		useWhen: "The goal is open-ended and its subtasks/shape aren't known up front.",
		inputHint: '{ "goal": "...", "maxSubtasks": 6, "concurrency": 3 }',
		primitives: ["agent(schema)", "parallel", "topological"],
		defaultName: "orchestrator-workers",
		useCases: [
			"Multi-part deliverables",
			"Research/build goals with interdependencies",
			"Decompose an open goal into a subtask graph",
		],
	},
	{
		key: "composition-driver",
		title: "Composition driver",
		category: "compose",
		blurb: "Parent workflow: discover claims, delegate verification to verify-claims-lib, then synthesize.",
		useWhen: "You want a worked parent + reusable sub-workflow, or that exact discover→verify flow.",
		inputHint: '{ "topic": "claims in our SSE parity doc" }',
		primitives: ["agent", "workflow", "sub-workflow"],
		defaultName: "composition-driver",
		useCases: [
			"Fact-check a document",
			"Separate discovery from reusable verification",
			"The canonical composition reference",
		],
	},
	{
		key: "verify-claims-lib",
		title: "Lib: verify claims",
		category: "compose",
		blurb: "Reusable sub-workflow: verify { claims, skeptics? } with skeptic juries; returns verified/dropped/votes/coverage.",
		useWhen: "A parent workflow needs verification as a building block.",
		inputHint: '{ "claims": [{ "id": "c1", "claim": "..." }], "skeptics": 3 }',
		primitives: ["parallel", "agent(schema)", "library contract"],
		defaultName: "verify-claims-lib",
		useCases: [
			"Called by composition-driver",
			"Any parent that discovers then verifies",
			"A shared verifier building block",
		],
	},
	{
		key: "workflow-factory",
		title: "Workflow factory (meta)",
		category: "compose",
		blurb: "Meta-workflow: catalog → plan → generate → review → refine, then write .pi/workflows/drafts/<slug>.js.",
		useWhen: "No existing workflow fits and you want a task-specific one scaffolded.",
		inputHint: '{ "task": "audit GraphQL resolvers for N+1 queries", "write": true }',
		primitives: ["agent(schema)", "prompt design", "writeFile"],
		defaultName: "workflow-factory",
		useCases: [
			"Bootstrap a new pattern",
			"Specialize the closest existing scaffold",
			"Generate a draft to inspect before trusting",
		],
	},
	{
		key: "recursive-compose",
		title: "Recursive compose (reference)",
		category: "compose",
		blurb: "Reference (pi, depth ≤ 3): a node re-gates a sub-task via contract-gate, then dispatches via router — bounded recursion.",
		useWhen: "You want the worked pattern for Phase-0-from-inside plus recursive dispatch.",
		inputHint: '{ "task": "audit + fix the SSE decoder" }',
		primitives: ["workflow", "contract-gate", "router"],
		defaultName: "recursive-compose",
		useCases: [
			"Self-similar gate→compose pipelines",
			"Carry the gate's resourcePlan budget into a deeper run",
			"Bounded recursive dispatch",
		],
	},

	// ── Discover & fan-out / generate & select / iterate & refine (category: scaffold) ──
	{
		key: "fan-out-and-synthesize",
		title: "Fan-out and synthesize",
		category: "scaffold",
		blurb: "Scatter-gather: scout a work-list, one reviewer per item (parallel, settle), synthesize-as-judge with coverage/failure notes.",
		useWhen: "You need broad independent coverage of a known-ish work-list.",
		inputHint: '{ "lens": "security", "limit": 20 }',
		primitives: ["agent", "parallel(settle)", "synthesis-as-judge"],
		defaultName: "fan-out-and-synthesize",
		useCases: [
			"Spread review across many files",
			"Multi-angle synthesis",
			"Run independent reviewers over a capped work-list",
		],
	},
	{
		key: "scout-fanout",
		title: "Scout → adaptive fan-out",
		category: "scaffold",
		blurb: "Scout then adaptive-depth pipeline: risk-classify every file cheaply, deep-review only high/medium; low-risk short-circuits.",
		useWhen: "You want coverage but only want to pay for the risky items.",
		inputHint: '{ "pattern": "config", "lens": "security", "maxFiles": 40 }',
		primitives: ["agent(schema)", "pipeline", "adaptive depth"],
		defaultName: "scout-fanout",
		useCases: ["Triage-then-review a large tree", "Classify-and-act passes", "Spend budget only where it pays"],
	},
	{
		key: "repo-bug-hunt",
		title: "Repo bug hunt",
		category: "use-case",
		blurb: "Scout code files, per-file bug reviewers, judge dedupes + prioritizes with citations. Findings are leads, not confirmed bugs.",
		useWhen: "You want a prioritized, cited list of suspected bugs across a repo.",
		inputHint: '{ "maxFiles": 30, "lens": "security" }',
		primitives: ["agent", "parallel(settle)", "synthesis-as-judge"],
		defaultName: "repo-bug-hunt",
		useCases: ["Repo audit", "Pre-review sweep (then confirm with bug-verify)", "Prioritized cited findings"],
	},
	{
		key: "loop-until-dry",
		title: "Loop until dry",
		category: "scaffold",
		blurb: "Keep fanning out finders until K consecutive quiet rounds or maxRounds.",
		useWhen: "The set you're discovering is unknown-size and you want exhaustiveness.",
		inputHint: '{ "target": "all places we parse SSE chunks", "quietRounds": 2, "maxRounds": 8 }',
		primitives: ["parallel(settle)", "loop", "log"],
		defaultName: "loop-until-dry",
		useCases: ["Enumerate all call-sites/edge-cases", "Find everything that…", "Stop on quiet rounds"],
	},
	{
		key: "react-scout",
		title: "ReAct scout (grounded)",
		category: "scaffold",
		blurb: "ReAct reason → act → observe loop: each step grounds a thought in a real read-only observation before the next.",
		useWhen: "You need an evidence-grounded scout before committing or fanning out.",
		inputHint: '{ "question": "Where does the WASM decoder get fed bytes?" }',
		primitives: ["agent", "tools", "grounded loop"],
		defaultName: "react-scout",
		useCases: ["Grounded investigation", "Produce a trace to hand to a fan-out", "Ground each step in observations"],
	},
	{
		key: "complex-research",
		title: "Complex research",
		category: "use-case",
		blurb: "Independent research angles (each runs web search), synthesized as judge with citations and coverage gaps.",
		useWhen: "You need a cited answer to an external question.",
		inputHint: '{ "question": "WASM vs NAPI FFI for Node in 2026?" }',
		primitives: ["parallel(settle)", "agent(web_search)", "synthesis-as-judge"],
		defaultName: "complex-research",
		useCases: [
			"Technology comparisons",
			"Literature/landscape scans",
			"Source-backed answers (pair with a verify step)",
		],
	},
	{
		key: "adversarial-verify",
		title: "Adversarial verify (jury)",
		category: "scaffold",
		blurb: "Per-finding skeptic jury that prunes by majority refutation; default-to-doubt.",
		useWhen: "You have findings/claims and want only the ones that survive refutation.",
		inputHint: '{ "topic": "security claims about our token flow", "skeptics": 5 }',
		primitives: ["parallel", "agent(schema)", "voting"],
		defaultName: "adversarial-verify",
		useCases: ["Prune a noisy findings list", "Sanity-check claims before acting", "Drop hallucinated findings"],
	},
	{
		key: "bug-verify",
		title: "Bug verify (reproduce)",
		category: "use-case",
		blurb: "Confirm suspected bugs by REPRODUCTION: real only if a run fails on current code; optional FAIL→PASS fix check + minimization.",
		useWhen: "You must prove a bug, not argue it. Runs sequentially on the working tree.",
		inputHint: '{ "topic": "SSE decoder drops final chunk", "verifyCmd": "npm test" }',
		primitives: ["agent", "bash", "sequential repro"],
		defaultName: "bug-verify",
		useCases: ["Confirm repo-bug-hunt leads", "Reproduce-and-fix loop", "Prove a bug with a failing run"],
	},
	{
		key: "adversarial-plan-review",
		title: "Adversarial plan review",
		category: "use-case",
		blurb: "N fixed-angle reviewers (correctness, security, maintainability, scope) synthesize a revised plan.",
		useWhen: "You want a plan stress-tested before building.",
		inputHint: '{ "plan": "the implementation plan" }',
		primitives: ["parallel(settle)", "reviewer panel", "synthesis-as-judge"],
		defaultName: "adversarial-plan-review",
		useCases: ["Design/RFC review", "Pre-implementation gate", "Find reasons not to ship a plan"],
	},
	{
		key: "judge-escalate",
		title: "Judge + escalate",
		category: "scaffold",
		blurb: "Generate candidates from distinct angles, typed judge, escalate only when confidence is low.",
		useWhen: "Best-of-N where you'd rather deepen than commit to a weak winner.",
		inputHint: '{ "question": "Best rollback strategy for the gate?" }',
		primitives: ["parallel", "agent(schema)", "adaptive loop"],
		defaultName: "judge-escalate",
		useCases: ["Decisions with a clear winner most of the time", "Adaptive spend", "Best-of-N options"],
	},
	{
		key: "tournament",
		title: "Tournament (bracket)",
		category: "scaffold",
		blurb: "Single-elimination bracket: pairwise judge rounds until one candidate survives.",
		useWhen: "Absolute scoring is unreliable but pairwise comparison is easy.",
		inputHint: '{ "candidates": ["a", "b", "c", "d"] }',
		primitives: ["agent(schema)", "bracket", "pairwise"],
		defaultName: "tournament",
		useCases: ["Pick the best of several drafts/designs", "Comparative ranking", "Head-to-head selection"],
	},
	{
		key: "self-consistency",
		title: "Self-consistency (vote)",
		category: "scaffold",
		blurb: "Sample N independent reasoning paths, pick by consensus (vote), tie-broken by an evidence-weighing judge.",
		useWhen: "A single chain might be wrong and agreement is the signal you trust.",
		inputHint: '{ "question": "Does this code path leak the handle?", "samples": 7 }',
		primitives: ["parallel", "voting", "agent(schema)"],
		defaultName: "self-consistency",
		useCases: [
			"High-variance reasoning/math/judgment",
			"Report the consensus margin",
			"Agree on one answer across paths",
		],
	},
	{
		key: "tree-of-thoughts",
		title: "Tree of thoughts",
		category: "scaffold",
		blurb: "Beam search over partial solutions: expand K thoughts, judge-score, prune to top-B, recurse to depth, commit.",
		useWhen: "The problem has intermediate steps worth exploring, not just final candidates.",
		inputHint: '{ "problem": "Design the gate rollout in 4 staged steps.", "branching": 3, "beam": 2 }',
		primitives: ["parallel", "agent(schema)", "beam search"],
		defaultName: "tree-of-thoughts",
		useCases: ["Multi-step planning/design search", "Explore a solution space", "Expand → score → prune → commit"],
	},
	{
		key: "self-refine",
		title: "Self-refine",
		category: "scaffold",
		blurb: "Bounded in-place generate → critique → refine with verbal memory; quiet-stop when the critic is satisfied.",
		useWhen: "You want to polish one artifact and the critique can be intrinsic.",
		inputHint: '{ "task": "Write the migration guide section.", "useJury": true }',
		primitives: ["agent", "loop", "workflow"],
		defaultName: "self-refine",
		useCases: ["Doc/spec/code polish", "Iterate to quality on one artifact", "Optional jury critic"],
	},
	{
		key: "reflexion",
		title: "Reflexion (trial loop)",
		category: "scaffold",
		blurb: "Verbal-RL outer trial loop: re-attempt each trial carrying self-reflections; evaluator can be externally grounded (verifyCmd).",
		useWhen: "A fresh re-attempt beats editing in place, and you have an objective oracle.",
		inputHint: '{ "task": "Make the failing decoder test pass.", "verifyCmd": "npm test -- decoder" }',
		primitives: ["agent", "bash", "trial loop"],
		defaultName: "reflexion",
		useCases: ["Code-with-tests", "Tasks with a pass/fail signal", "Reset-and-re-attempt vs edit-in-place"],
	},
	{
		key: "large-migration",
		title: "Large migration (applier)",
		category: "use-case",
		blurb: "A real applier: green-baseline gate, per-file apply → verify → bounded-repair, rollback on failure. Sequential.",
		useWhen: "You're mutating many files and must never leave a broken one behind.",
		inputHint: '{ "instruction": "Replace X(...) with Y(...)", "verifyCmd": "npm test", "dryRun": true }',
		primitives: ["agent", "bash", "apply/verify/rollback"],
		defaultName: "large-migration",
		useCases: ["API/codemod rollouts", "Framework upgrades", "Capped, evidence-backed migration"],
	},
	{
		key: "map-reduce",
		title: "Map-reduce (hierarchical)",
		category: "scaffold",
		blurb: "Hierarchical map-reduce: per-chunk map under an evidence contract, reduce in bounded batches to one summary-of-summaries.",
		useWhen: "The input is bigger than one context window.",
		inputHint: '{ "instruction": "Extract every breaking API change", "content": "..." }',
		primitives: ["parallel", "agent", "recursive reduce"],
		defaultName: "map-reduce",
		useCases: ["Summarize a huge doc/log", "Roll up hundreds of tickets", "Extract across a large corpus"],
	},
];

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
	return pattern.useCases ?? [];
}
