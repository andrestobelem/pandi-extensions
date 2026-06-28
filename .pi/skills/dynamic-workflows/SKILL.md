---
name: dynamic-workflows
description: >-
  Use for Claude Code-style dynamic workflows in Pi: creating or running JavaScript
  orchestration scripts with parallel subagents for complex repo-wide analysis,
  migrations, audits, deep research, adversarial verification, or repeated
  evaluation workflows.
---

# Dynamic Workflows for Pi

Use this skill when a task is too large or valuable for a single linear agent turn and would benefit from orchestration: repo-wide bug hunts, security/performance audits, large migrations/refactors, deep research, adversarial verification, generate-and-filter workflows, tournament/ranking, or loop-until-done checks.

## When to build a workflow (decision)

Work through step zero and then the three gates in order. Most tasks stop early.

0. **Contract Gate.** Convert the raw request into an inspectable task contract. Decide whether ambiguity blocks routing or implementation; if it does, infer concise success criteria when safe or ask only blocking questions. Use the improved task, success criteria, assumptions, non-goals, routing hints, verification plan, and blockers for the routing/scouting decision.
1. **Trivial gate.** Conversational, single-step, or a handful of direct tool calls -> just do it. A workflow spends many model calls; don't pay that for a quick edit, lookup, or one-file change.
2. **Scout inline first.** When a task *might* be large, probe it cheaply, inline, in the current turn: `git ls-files`, read the PR diff, `grep`/glob candidates, list channels. This reveals the real work-list and its size. You don't need the shape before the *task*, only before the *orchestration step*.
3. **Orchestrate only for a real reason.** After scouting, build a workflow only when one holds: **Exhaustiveness** (many independent items to cover in parallel), **Confidence** (high-stakes; independent perspectives + adversarial verification *before* you commit), **Scale** (more context than one window holds: repo-wide audits, large migrations, broad sweeps with artifacts/checkpoints). If none hold, stay single-agent.

### Scale effort to the ask

| Ask | Shape |
| --- | --- |
| "find some bugs", "quick read" | scout -> small fan-out (~3-5 finders) -> light synthesis |
| "review this plan", "is this safe" | a few perspective-diverse reviewers -> synthesis-as-judge |
| "audit thoroughly", "be exhaustive" | larger pool -> adversarial checks per finding -> judge/synthesis -> repeat while new findings appear |

### Choosing concurrency and maxAgents

Do not treat low defaults as a ceiling. After the inline scout reveals the work-list, choose `concurrency` and `maxAgents` from the actual shape of the task:

- Raise them for many independent, read-only, low-risk branches: repo/file audits, call-site sweeps, broad research angles, independent reviewers, or verification panels.
- Keep them low for side effects, expensive models, shared-state edits, sequential dependencies, flaky/rate-limited providers, or tasks where one branch's output changes the next branch's prompt.
- Size `maxAgents` for the total planned branch budget across all phases, not just peak parallelism. Size `concurrency` for safe simultaneous work.
- Clamp to `ctx.limits.concurrency` and `ctx.limits.maxAgents`, but log requested vs effective values and what is delayed, skipped, sampled, or excluded.
- A fallback like `Math.min(4, items.length, ctx.limits.concurrency)` is acceptable for small/uncertain work; for large independent read-only sweeps, consider 8-12+ if limits and provider budget allow.

Unknown size -> prefer a loop-until-done pattern over a fixed count.

### No silent caps

If you bound coverage (top-N, sampling, no-retry, clamping to `ctx.limits.concurrency`), `ctx.log()` what was excluded ("reviewed 40 of 213 matching files; skipped generated/ and vendored paths") so the cap is inspectable.

## Choosing a primitive (pipeline vs agents vs parallel)

Pick by data dependency, not by aesthetics.

1. **One independent step per item?** `ctx.agents(items, { concurrency })` — bounded parallel map.
2. **Two or more dependent steps PER item, with no cross-item merge?** `ctx.pipeline(items, ...stages)` — default for multi-stage work. Each item flows through all stages independently; failed items return `null`. Stage callbacks receive `(prevResult, originalItem, index)`.
3. **Large fan-out or reviewer panel where one branch may fail?** `ctx.agents(items, { concurrency, settle: true })` — returns `null` for a failed branch instead of failing the whole batch. Filter nulls and `ctx.log()` how many failed.
4. **A later step needs ALL branch results at once?** `ctx.parallel([async () => ..., async () => ...])` — a barrier over async thunks, locally bounded by `ctx.limits.concurrency`; failed thunks return `null`. Use only for global dedup/merge, early-exit when the total is zero, cross-branch ranking, or other true barriers.
5. **Reusable sub-step with no decision gate?** `ctx.workflow(name, input)` — compose a sub-workflow inline, depth 1, sharing this run's `runDir`, agent budget, concurrency, abort signal, and resume journal/cache. Use `lib/<name>` for reusable contracts like claim verification. If you must inspect results before deciding the next phase, run separate workflows sequentially instead.

**Barrier smell test:** `parallel -> transform-with-no-cross-item-dependency -> parallel` should be one `ctx.pipeline`. `map`/`filter`/formatting alone do not justify a barrier; dedup, merge, early-exit, and compare-against-others do.

**Resume/cache note for pipeline:** include a stable item id or `index` in prompts generated by stages. Two items with identical prompts can otherwise race for the same cache occurrence.

**Robustness is explicit:** settling variants make failures visible as `null`; synthesis prompts should mention failed, empty, stale, or timed-out branches instead of hiding them.

**Loops:** wrap any primitive in loop-until-count (fixed N) or loop-until-done (stop after K quiet rounds, dedupe by stable key) when discovery size is unknown.

## Research-backed templates

Map common agent papers/frameworks to Pi workflow design:

- **ReAct** -> scout/observe with tools before fan-out; keep reasoning tied to evidence.
- **Self-consistency** -> sample independent branches, then select by consistency/evidence rather than trusting one path.
- **Reflexion / Self-Refine** -> generate -> critique -> refine loops, always bounded by rounds, quiet stops, `maxAgents`, and timeout.
- **Tree of Thoughts** -> branch alternatives, evaluate/prune with a judge, then commit to one path.
- **Multiagent debate** -> adversarial reviewers plus synthesis-as-judge; unsupported claims are dropped.
- **AutoGen / CAMEL / MetaGPT** -> explicit roles, stable artifacts, and clear handoff contracts.
- **SWE-agent / DSPy** -> interface and contracts matter: narrow tools, schemas/fixed formats, and reproducible checks.

Use these as patterns, not ceremony: every branch needs a reason, a contract, and a stop condition.

## Structured output and personas

Use `ctx.agent(prompt, { schema })` when a branch must return machine-readable JSON. The result includes:

- `result.output` — assistant text, reconstructed from Pi JSON event mode.
- `result.data` — parsed JSON value when it matches the schema.
- `result.schemaOk` — `true` on validation success, `false` when `schemaOnInvalid: "null"` allows an invalid result to return.

Options: `schemaRetries` (default `2`) retries with validation feedback; `schemaOnInvalid: "throw" | "null"` controls whether invalid output throws or returns `{ schemaOk:false, data:null }`.

Use `agentType` for persona defaults before cache-key computation: `explore`, `reviewer`, `planner`, `implementer`, `researcher`. Explicit options win; `appendSystemPrompt` is concatenated. Trusted projects may define `.pi/personas/<name>.json` with persona defaults.

## Per-call model and thinking selection

Each subagent call decides, independently, **which model/provider to use and with which thinking (reasoning) level to launch**. Pass these on `ctx.agent`, `ctx.agents`, `ctx.pipeline`, or any per-item spec:

- `model` — model pattern or id, e.g. `"anthropic/claude-sonnet-4"` or just `"haiku"` (pi resolves `provider/id` and an optional `:<thinking>` suffix). Becomes `--model`.
- `provider` — restrict to a provider, e.g. `"openai"`. Becomes `--provider`. When `provider` is set without `model`, no model is synthesized (pi picks within that provider).
- `thinking` — reasoning effort, one of `off | minimal | low | medium | high | xhigh`. Becomes `--thinking`.

Defaults inherit the orchestrator: a call with no `model`/`provider` reuses the workflow's own model (`ctx.model`), and a call with no `thinking` reuses the current session thinking level (`pi.getThinkingLevel()`). `agentType` personas set thinking defaults too (`reviewer`/`planner`/`researcher` → `high`, `explore`/`implementer` → `medium`); explicit options override them.

`model`, `provider`, and `thinking` are part of the cache key, so changing them re-runs that call on resume instead of reusing a stale result.

Build prompts with a **stable prefix**: put shared/stable framing (role, task, success criteria, output format) first and push volatile per-item content (the item, ids, retrieved snippets) to the end. Identical prefixes reuse the provider prompt/KV cache across calls (cheaper, faster, steadier focus); avoid `Date.now()`/`Math.random()` or other nondeterministic values inside prompts, which bust that cache and also make the resume journal miss.

Match cost and capability to the work, deciding per call:

- **Wide, cheap scouting / classification / extraction** → a fast, inexpensive model with `thinking: "low"` (or `"minimal"`/`"off"`).
- **Synthesis, adversarial verification, planning, hard reasoning** → a stronger model and `thinking: "high"` (or `"xhigh"` for the hardest judge/synthesis step).

```js
// Cheap parallel scouts, then one strong, high-reasoning synthesis.
const notes = await ctx.agents(files.map((f) => ({
  name: `scout-${f}`, prompt: `Summarize risks in ${f}. Cite lines.`,
  model: "haiku", thinking: "low", tools: ["read", "grep", "find", "ls"],
})), { concurrency: 8 });
const verdict = await ctx.agent(
  `Synthesize the scout notes into a ranked, evidence-backed verdict.\n\n${ctx.compact(notes, 50000)}`,
  { name: "synthesis", model: "anthropic/claude-sonnet-4", thinking: "high", tools: ["read", "grep", "find", "ls"] },
);
```

Per-agent access is explicit: pass `tools`/`excludeTools` to scope Pi tools, `skills: ["/path/to/skill"]` and `extensions: ["/path/to/extension.ts"]` to load needed skill/extension resources, and `keys: ["ENV_VAR_NAME"]` to expose only named environment keys to that subagent in an isolated environment (values are redacted in artifacts). By default, Dynamic Workflows tries to make web search available by loading `pi-codex-web-search` explicitly and appending `web_search` to explicit tool allowlists; opt out with `includeExtensions: false` or `excludeTools: ["web_search"]`. Normal skill discovery stays on, so `context7-cli` is available when installed; explicit skill lists also get `context7-cli` appended when found, unless `includeSkills: false`. Use `includeSkills: true` / `includeExtensions: true` only when you intentionally want normal discovery in addition to explicit paths. Use `env: { NAME: "value" }` only for non-prompt secrets you intentionally inject; prefer env var names and never write secret values into prompts. Cache keys redact credential values, so use `{ cache: false }` when a branch depends on a rotated/exact secret value.

## Core Tool and Commands

Use the `dynamic_workflow` tool.

Core routing:

- The extension runs an always-on ultracode router by default: for each substantive task, Pi should evaluate whether a dynamic workflow is warranted and proceed normally for simple tasks.
- Users can explicitly invoke `/ultracode <task>`, `/deep-research <question>`, or start a message with `ultracode ...` to request this workflow style.
- Use `/ultracode-mode status|on|off` to inspect or toggle the always-on router for the current session.

Run semantics:

- In persistent TUI/RPC sessions, workflows always launch in background (`action:"start"`; `action:"run"`/`"resume"` are backgrounded by the extension). `run` is foreground only as a print/json fallback.
- Inspect runs with `dynamic_workflow action=view|runs` or `/workflow view [latest|runId]` / `/workflow runs`.

Dashboard and catalog:

- `/workflows` opens the TUI dashboard (`Ctrl+Alt+W`, or `↓` when the editor cannot move further down) with Monitor, Agents, Runs, Workflows, Patterns, and Activity tabs.
- Patterns is the scaffold catalog; use Enter/n to create an editable project workflow draft.
- Monitor/Agents show current parallel agent count, peak, live agent details, and `P<phase> 1/n` phase markers. Use `c`/`x` to cancel active runs with confirmation and `d`/Delete to delete inactive run artifacts or workflow files.
- `/workflow patterns` opens or prints the catalog. `/workflow graph <name>` renders Mermaid/PNG when available, with text fallback.

If a run was interrupted (state `stale`, `failed`, or `cancelled`), resume it in place with `dynamic_workflow({ action: "resume", name: "<runId>" })` (or `/workflow resume <runId>`). Completed subagent and bash calls are read from the run journal and are not re-executed, so resuming is cheap. `ctx.agent()` is cached by default (opt out with `{ cache: false }`); `ctx.bash()` is cached only with `{ cache: true }`. Calls whose arguments depend on `Date.now()`/`Math.random()` will not match the cache and will re-run on resume.

Typical loop:

0. Run the Contract Gate. Convert the raw request into an inspectable task contract; if ambiguity blocks routing or implementation, infer concise success criteria when safe or ask only blocking questions. Then route from the improved task.
1. `dynamic_workflow({ action: "template" })` to inspect the pattern catalog (or `action:"template", name:"<key>"` for one scaffold).
2. Dynamically write a task-specific project workflow with `action: "write"`, usually under the gitignored `.pi/workflows/drafts/<task-slug>.js` project draft path (`name: "<task-slug>"`). Use existing workflows/examples only as references unless one exactly matches the task.
3. Launch it in background with `action: "start"` and explicit `input`, `concurrency`, and `maxAgents` chosen from the discovered work-list and constraints, not from a fixed low default (in TUI/RPC, `action:"run"` is also backgrounded; in print/json it is the foreground fallback).
4. Inspect execution with `dynamic_workflow({ action: "view", name: "latest" })` or read artifacts from the reported run directory.
5. Synthesize the final answer from workflow output and artifacts, then tell the user the generated workflow path and offer to keep/promote/delete it.

If the user likes a generated workflow, promote it by reading `<task-slug>` and writing the same code, cleaned/generalized if needed, to a stable name such as `<domain>-audit` or `<team>-research`. If they do not want it, delete the generated draft.

## Workflow Patterns

Dynamic workflows should be generated for the concrete task after scouting. Do not treat checked-in examples as canned jobs; treat them as pattern references. Generated workflows are drafts by default; keep/promote them only when the user likes the result or wants reuse.

The pattern catalog is visible in TUI (`/workflows` → Patterns or `/workflow patterns`) and from the tool (`dynamic_workflow action=template`). It lists concrete patterns and use cases, without pattern aliases. The visible catalog is compact and Claude-style: templates (`classify-and-act`, `fan-out-and-synthesize`, `adversarial-verification`, `generate-and-filter`, `tournaments`, `loop-until-done`), compose templates (`compose-verify-claims`, `lib-verify-claims`, `workflow-factory`), and use-cases (`bug-hunt-repo-audit`, `large-migration`, `complex-research`, `plan-review`, `claim-bug-verification`). Legacy intents `deep-research` and `default` live as skills that route to `complex-research` and `fan-out-and-synthesize` respectively.

Ultracode prompts carry only a short key list for this catalog. Before hand-writing a workflow, inspect `dynamic_workflow action=template`, choose the closest scaffold, or explicitly say why no template fits; for composition, prefer `ctx.workflow("lib/<name>", args)` only for reusable sub-steps with no decision gate, keep `lib/` contracts stable and JSON-serializable, and sequence separate runs when the next phase depends on inspecting previous artifacts.

- **Workflow factory / meta-workflow**: for complex workflow/prompt/contract design tasks where a workflow is warranted, first run `workflow-factory` with `{ task, write:true }`; it designs prompts/contracts, generates a task-specific workflow draft under the gitignored `.pi/workflows/drafts/<slug>.js` path, reviews it, and leaves inspectable artifacts.
- **Composition**: use `compose-verify-claims` + `lib-verify-claims` as examples of `ctx.workflow("lib/verify-claims", args)` when a reusable sub-step needs no decision gate.
- **Fan-out and synthesize**: split files/topics among subagents, then run a synthesis subagent.
- **Classify and act**: classify many items, then run targeted follow-ups only on high-signal items.
- **Adversarial verification**: have independent agents critique/verify a plan or patch.
- **Generate and filter**: generate multiple candidates, then evaluate and select.
- **Tournament/ranking**: compare candidates pairwise or by rubric.
- **Loop until done**: repeat detect → fix/verify until no findings or an explicit cost/time limit is reached.

## Prompting Patterns

Use prompts that make the orchestration pattern explicit:

- **Independent fan-out prompts**: tell each subagent its perspective must be complete even if others fail.
- **Evidence contracts**: require file/line citations, URLs, commands, or `INSUFFICIENT_EVIDENCE` / `NO_FINDINGS`.
- **Structured output**: prefer `ctx.agent(prompt, { schema })` for JSON objects; otherwise ask for fixed sections such as Verdict, Findings, Evidence, Risks, Fixes, and Verification gaps.
- **Synthesis-as-judge**: the final agent should deduplicate, discard unsupported claims, preserve uncertainty, and choose a concrete recommendation instead of averaging opinions.
- **Adversarial review**: give critics an explicit goal to reduce scope, find edge cases, and identify accepted risks.
- **Partial failure handling**: synthesis prompts should mention failed, empty, stale, or timed-out agents instead of hiding them.
- **Safety by default**: for audits, say “do not edit files” and restrict tools to read-only.

## Workflow API Reminders

Workflow files export:

```js
module.exports = async function workflow(ctx, input) {
  await ctx.log("start", { input });
  const result = await ctx.agent("Do a focused task", { tools: ["read", "grep", "find", "ls"] });
  await ctx.writeArtifact("result.json", result);
  return result.output;
};
```

Useful helpers:

- `ctx.agent(prompt, options)` — run one Pi subagent; supports `model`, `provider`, `thinking`, `tools`, `excludeTools`, `skills`, `includeSkills`, `extensions`, `includeExtensions`, `keys`, `env`, `schema`, `schemaRetries`, `schemaOnInvalid`, and `agentType`. `model`/`provider`/`thinking` are chosen per call (see Per-call model and thinking selection).
- `ctx.agents(items, { concurrency })` — run many subagents with bounded concurrency.
- `ctx.agents(items, { concurrency, settle: true })` — keep a fan-out running when one branch fails; failed branches return `null` and should be logged/filtered.
- `ctx.pipeline(items, ...stages)` — multi-stage per-item flow without global barriers; failed items return `null`.
- `ctx.parallel([async () => ...])` — worker-side barrier for arbitrary async branches; bounded by `ctx.limits.concurrency`, returns `null` per failed thunk.
- `ctx.workflow(name, input)` — compose a reusable sub-workflow inline (depth 1, shared limits/abort/cache/runDir); emits workflow events.
- `ctx.bash(command)` — run shell commands.
- `ctx.readFile`, `ctx.writeFile`, `ctx.appendFile`, `ctx.listFiles` — file helpers confined to the workflow cwd.
- `ctx.writeArtifact(name, data)` — persist intermediate state in the run directory.
- `ctx.compact(value, maxChars)` — JSON/stringify and truncate large results.
- `ctx.limits` — read-only effective limits; clamp workflow concurrency to `ctx.limits.concurrency`.

## Safety and Cost

- Do not use workflows for simple tasks.
- Workflows are trusted JavaScript and can spawn many model calls.
- Keep `maxAgents` and `concurrency` explicit, and raise them above small fallbacks when the scout finds many independent read-only branches and the run/provider limits allow it.
- For audits/research, restrict subagents to read-only tools: `tools: ["read", "grep", "find", "ls", "web_search"]`.
- Web search and Context7 are default conveniences when installed; opt out per agent with `includeExtensions: false` / `excludeTools: ["web_search"]` and `includeSkills: false`.
- For other skills/extensions/credentials, grant only what each subagent needs, e.g. `skills: ["/path/to/skill"]`, `extensions: ["/path/to/ext.ts"]`, `keys: ["GITHUB_TOKEN"]`; dashboards/artifacts show names/paths and missing keys, never secret values.
- Avoid `bash` unless the workflow genuinely needs shell/web access.
- Keep subagent prompts narrow and require line/file citations when relevant.
- Prefer explicit prompt contracts over vague requests: role, evidence rules, output format, confidence, and what to do when blocked.
