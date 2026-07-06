import { StringEnum } from "@earendil-works/pi-ai";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { HARD_MAX_AGENTS, HARD_MAX_CONCURRENCY } from "./config.js";
import { formatWorkflowCompositionPromptSummary, formatWorkflowPatternKeyList } from "./pattern-scaffolds.js";
import type { DynamicWorkflowAction } from "./types.js";

export const TOOL_ACTIONS = [
	"list",
	"scaffold",
	"read",
	"check",
	"write",
	"run",
	"start",
	"resume",
	"cancel",
	"delete",
	"graph",
	"runs",
	"view",
	"report",
] as const satisfies readonly DynamicWorkflowAction[];
const WORKFLOW_SCOPE_INPUTS = ["auto", "project", "global"] as const;

export const workflowToolSchema = Type.Object({
	action: StringEnum(TOOL_ACTIONS, {
		description:
			"Workflow operation to perform: list/scaffold/read/check/write/run/start/resume/cancel/delete/graph/runs/view/report. check validates a workflow and input before creating a run. scaffold with no name lists the pattern catalog; scaffold with name=<key> returns a pattern scaffold. resume re-runs an interrupted run (stale/failed/cancelled) in place, reusing cached completed subagent/bash calls so they are not re-executed. report renders a run (default: latest) into a self-contained <runDir>/report.html; pass watch=true to regenerate it while the run is running.",
	}),
	name: Type.Optional(
		Type.String({
			description:
				"Workflow name/path relative to the workflow directory (.js is added when omitted), run id for view/cancel/resume (defaults to latest for resume), or pattern key for action=scaffold.",
		}),
	),
	scope: Type.Optional(
		StringEnum(WORKFLOW_SCOPE_INPUTS, {
			description: `Use project ${CONFIG_DIR_NAME}/workflows, global agent-dir workflows, or auto resolution.`,
		}),
	),
	code: Type.Optional(Type.String({ description: "JavaScript workflow source for action=write." })),
	input: Type.Optional(
		Type.Any({
			description: "JSON-serializable input passed to action=run/start workflow(ctx, input).",
		}),
	),
	background: Type.Optional(
		Type.Boolean({
			description:
				"Compatibility flag for action=run/resume. In persistent TUI/RPC sessions, workflows always start in background; print/json mode falls back to foreground because no background session stays alive.",
		}),
	),
	force: Type.Optional(
		Type.Boolean({
			description: "For action=resume, allow resuming an already completed run (re-runs only uncached calls).",
		}),
	),
	watch: Type.Optional(
		Type.Boolean({
			description:
				"For action=report, keep regenerating <runDir>/report.html while the run is running; the final report removes browser auto-refresh.",
		}),
	),
	concurrency: Type.Optional(
		Type.Integer({
			minimum: 1,
			maximum: HARD_MAX_CONCURRENCY,
			description: "Default subagent concurrency.",
		}),
	),
	maxAgents: Type.Optional(
		Type.Integer({
			minimum: 1,
			maximum: HARD_MAX_AGENTS,
			description: "Maximum subagents a workflow may spawn.",
		}),
	),
	timeoutMs: Type.Optional(Type.Integer({ minimum: 1_000, description: "Overall workflow timeout in milliseconds." })),
	agentTimeoutMs: Type.Optional(
		Type.Integer({
			minimum: 1_000,
			description: "Default timeout for each subagent in milliseconds.",
		}),
	),
});

export function makeWorkflowPromptGuidelines(): string[] {
	return [
		"Step zero before orchestrating: decide whether the task prompt needs improvement. If ambiguity blocks routing or implementation, infer concise success criteria when safe or ask only blocking questions. Use that improved prompt for the routing/scouting decision.",
		"Decide in three steps before orchestrating. (1) Trivial gate: if the task is conversational, single-step, or solvable with a few direct tool calls, answer normally — do NOT build a workflow. (2) Scout inline first: if it may be large, run a cheap probe inline (git ls-files, read the diff, grep/glob candidates) to discover the real work-list and size. (3) Orchestrate only for exhaustiveness (many independent items), confidence (independent perspectives + adversarial verification), or scale (more context than one window: migrations, audits, broad sweeps).",
		"Scale effort to the ask. 'Find some' / 'quick check' -> small fan-out (~3-5) + light synthesis. 'Review this plan' -> a few perspective-diverse reviewers + synthesis-as-judge. 'Audit thoroughly' / 'be exhaustive' -> larger pool, adversarial checks per finding, synthesis, and another round only if new findings keep appearing.",
		"Scale parallelism to the discovered work-list and constraints. Raise concurrency/maxAgents above low defaults for many independent, read-only, low-risk branches when the limits global and provider budget/rate limits allow; keep them low for side effects, expensive models, shared-state edits, sequential dependencies, or uncertain rate limits. Log requested/effective concurrency, maxAgents, and any limits clamp.",
		"Author a workflow with injected GLOBALS only — no ctx, no import/require: an optional `export const meta = { name, description, phases }` plus `export default async function main()` (or a top-level script ending in `return <value>`). Read input via the `args` global (JSON-stringified; parse defensively). Globals: agent, agents, parallel, pipeline, workflow, phase, log, args, bash, readFile/writeFile/appendFile/listFiles, writeArtifact, sleep, json, compact, and the read-only limits/runId/runDir/cwd. NEVER name your function after a global (use main); naming it `workflow` shadows the workflow() composition helper and self-recurses.",
		formatWorkflowPatternKeyList(),
		formatWorkflowCompositionPromptSummary(),
		"Choose primitives by data dependency. Use agents(items,{concurrency}) for one independent step per item. Use pipeline(items,...stages) by default for >=2 dependent steps per item with no cross-item merge; include a stable item id/index in prompts generated inside stages. Use agents(items,{concurrency,settle:true}) for large fan-out or reviewer panels where one branch failure should return null. Use parallel([()=>...]) only for a true barrier where a later step needs all branch results at once (dedup/merge, early-exit if total=0, cross-branch ranking). Use workflow(name,args) for reusable sub-steps with no decision gate; sequence separate runs when a decision depends on prior output.",
		"Use agent(prompt,{schema}) when a subagent must return JSON: agent() returns the parsed object directly with {schema} (the text output otherwise) and null on a failed subagent. The plural agents()/parallel()/pipeline() return result objects/arrays (read .output/.data; null per failed branch under settle). Use agentType:'explore'|'reviewer'|'planner'|'architect'|'implementer'|'researcher' for persona defaults; explicit options override the persona. Scope each subagent's access with tools/excludeTools, skills/includeSkills, extensions/includeExtensions, and keys/env when it needs specific capabilities; never put secret values in prompts. Subagents get web_search via pi-codex-web-search and context7-cli when installed; include web_search in read-only allowlists when web/docs/current evidence may help, and only use includeExtensions:false/includeSkills:false as an explicit opt-out.",
		"Decide model and effort per call as two independent dials, not one cheap↔deep slider: pass model ('haiku'|'sonnet'|'opus' or a full 'provider/id') and effort (low|medium|high|xhigh|max) on agent/agents/pipeline calls or any per-item spec (the node(role,extra) helper threads input.models/efforts/toolsByRole per role). model multiplies the price of every token; effort only caps thinking (low~2k/medium~8k/high~16k) and unused budget is free — don't couple cheap model to cheap thinking. Keep low for mechanical nodes (one pinned command/read, flat schema, output transcribed literally, verified downstream) and for small/crisp ranking scouts whose misses are cheap and visible; raise effort>=medium for ambiguous output, fuzzy judgment, long context, high cost of omission, or hard ranking. If a local A/B shows effort does not help but stronger models do, raise model instead. Use a strong model + high/xhigh only for final synthesis, adversarial verification, planning, and hard reasoning. ALWAYS set model on wide fan-out nodes — omitting it inherits the orchestrator model (an opus session prices every branch as opus); omitting effort inherits the raw session reasoning level unless an agentType persona raises it (reviewer/planner/architect/researcher=high, explore/implementer=medium), and explicit options win. model and effort are part of the cache key, so changing them re-runs that call on resume.",
		"Handle partial failure visibly: filter nulls from settling agents/pipeline/parallel, log() how many branches failed, and make synthesis prompts mention failed, empty, cancelled, or timed-out branches instead of hiding them. In synthesis/judge prompts, restate the task + success criteria at BOTH the start and the end (after the evidence block), most-important findings first, to counter lost-in-the-middle.",
		"Never cap coverage silently. Whenever a workflow uses slice/head/top-N/sampling/no-retry, clamps concurrency to limits.concurrency, or lowers maxAgents below the discovered work-list, log() exactly what was excluded, delayed, or clamped.",
		`When creating a workflow, inspect the pattern catalog first (optionally action=scaffold name=<key> for a scaffold), reuse an existing workflow only when it exactly matches the task, otherwise write a clear gitignored ${CONFIG_DIR_NAME}/workflows/drafts/<task-slug>.js project draft and launch it in background with explicit limits (action=start in persistent TUI/RPC; action=run only as the print/non-persistent fallback). If a workflow is warranted for complex workflow/prompt/contract design, use the workflow-factory scaffold so a workflow generates and reviews the task-specific workflow. After a useful run, tell the user the path and offer to keep/promote it to a stable workflow name.`,
		"Workflows in persistent TUI/RPC sessions always run in background: use dynamic_workflow action=start (or action=run, which the extension backgrounds there), then inspect with action=runs/view and stop with action=cancel if needed.",
		"Do NOT busy-poll a background run (no sleep/loop re-checking status.json or repeated action=view): the harness already tracks it and injects a completion notice when it finishes, so let it report back and inspect ONCE when notified (or when the user asks). While it runs, do other useful work instead of watching it.",
		"If a run was interrupted (state stale/failed/cancelled), use dynamic_workflow action=resume name=<runId> to continue it in place; completed subagent/bash calls are reused from the run journal and are not re-executed, so resuming is cheap. agent() output is cached by default (opt out with {cache:false}); bash() is cached only with {cache:true}. Calls whose arguments depend on Date.now()/Math.random() will not be cached and will re-run on resume.",
		"Build subagent prompts with a stable prefix: put shared/stable framing (role, task, success criteria, output format) FIRST and push volatile per-item content (the item text, ids, retrieved snippets) to the END, so identical prefixes reuse the provider prompt/KV cache across calls. Avoid Date.now()/Math.random() or other nondeterministic values inside prompts — they bust that cache and make the resume journal miss, re-running the call.",
		"Workflow scripts are trusted code. Keep subagent prompts scoped, use read-only tool lists for audit/research tasks, and persist intermediate outputs with writeArtifact().",
		"Use dynamic_workflow action=graph to explain a workflow before running it, and action=view/runs to inspect execution timelines and artifacts after running it.",
	];
}
