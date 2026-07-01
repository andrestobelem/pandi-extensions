# Workflow catalog (quick reference)

**Date:** 2026-07-01 | **Status:** durable reference | **Scope:** 25 dynamic-workflow scaffolds in `pi-dynamic-workflows`

## What this is

A human-readable index of every built-in workflow scaffold, grouped by family, with a one-line
description and the use cases it targets. Use it to pick the right pattern before authoring or
running a workflow.

**Source of truth (do not hand-maintain the list against these):**

- Live catalog: `dynamic_workflow action=scaffold` (or `/workflow patterns`); fetch one with `action=scaffold name=<key>`.
- Scaffold code: `extensions/pi-dynamic-workflows/scaffolds/*.js` (pi) and `.claude/workflows/*.js` (Claude Code) — 25 each.
- The `ultracode` skill (`.pi/skills/ultracode/SKILL.md`) carries the same catalog by family.

**Completeness check (2026-07-01):** 25 pi scaffolds, 25 Claude workflows, 25 in the skill's bundled reference. The skill's "pattern catalog" section names all 25 with no extras.

## How to choose

Walk the gates first (most tasks stop early): **Contract Gate → Trivial → Scout inline → Orchestrate only for exhaustiveness, confidence, or scale.** A single agent call beats a workflow for almost everything. Then pick a primitive by data dependency, and a pattern below by intent.

---

## 🚪 Gate & guard — frame and protect

| Workflow | What it does | Use cases |
| --- | --- | --- |
| `contract-gate` | Turn a vague ask into an inspectable contract (improved task, success criteria, assumptions, non-goals) and decide *ask-now vs proceed-on-a-recorded-assumption*. | Scope a fuzzy ticket; gate before a costly multi-agent run; rewrite a raw ask into a clean spec. |
| `guardrails` | Cheap input/output tripwire that **HALTS** on a clear violation; can wrap any workflow via `protect:{name,args}`. | Scope/safety gate before an agent; PII/secret check on an output; wrap a workflow with tripwires. |

## 🧭 Route & orchestrate

| Workflow | What it does | Use cases |
| --- | --- | --- |
| `router` | Classify a request and dispatch to the single best catalog workflow (or recommend-only). | A single front door for raw tasks; map a task to the right specialist; preview the pick with `runSelected:false`. |
| `orchestrator-workers` | A planner decomposes an open goal into a `dependsOn` subtask graph; workers execute level-by-level; an integrator merges. | Multi-part deliverables; research/build goals with interdependencies. |
| `map-reduce` | Hierarchical map-reduce: per-chunk map under an evidence contract, reduce in bounded batches to one summary-of-summaries. | Input bigger than one context window: huge doc/log, hundreds of tickets. |
| `workflow-factory` | Meta-workflow: catalog → plan → generate → review → refine, then write `.pi/workflows/drafts/<slug>.js`. | No existing workflow fits and you want a task-specific one; specialize the closest scaffold. |
| `recursive-compose` | Reference (pi, depth ≤ 3): a node re-gates a sub-task via `contract-gate`, then dispatches via `router` — bounded recursion. | Self-similar gate→compose pipelines; carry the gate's resource plan into a deeper run. |

## 🔍 Discover & fan-out

| Workflow | What it does | Use cases |
| --- | --- | --- |
| `fan-out-and-synthesize` | Scatter-gather: scout a work-list, one reviewer per item (parallel, settle), synthesize-as-judge with coverage/failure notes. | Broad independent coverage of a known-ish work-list; multi-angle synthesis. |
| `scout-fanout` | Scout + adaptive-depth pipeline: risk-classify every file cheaply, deep-review only high/medium; low-risk short-circuits. | Triage-then-review a large tree; spend budget only where it pays. |
| `repo-bug-hunt` | Scout files, per-file bug reviewers, judge dedupes + prioritizes with citations. Findings are **leads**, not confirmed bugs. | Repo audit; pre-review sweep (then confirm with `bug-verify`). |
| `loop-until-dry` | Keep fanning out finders until K consecutive quiet rounds or `maxRounds`. | Unknown-size set you want to exhaust: "find all call-sites / edge-cases". |
| `react-scout` | ReAct reason → act → observe loop: each step grounds a thought in a real read-only observation. | Evidence-grounded investigation before committing or fanning out. |
| `complex-research` | Independent research angles (each runs web search), synthesized as judge with citations and coverage gaps. | Cited answer to an external question: tech comparisons, landscape scans. |

## ✅ Verify

| Workflow | What it does | Use cases |
| --- | --- | --- |
| `adversarial-verify` | Per-finding skeptic jury that prunes by majority refutation; default-to-doubt. | Prune a noisy findings list; drop hallucinated findings before acting. |
| `bug-verify` | Confirm suspected bugs by **reproduction**: real only if a run fails on current code; optional FAIL→PASS fix check + minimization. Sequential. | Confirm `repo-bug-hunt` leads; reproduce-and-fix loop. |
| `verify-claims-lib` | Reusable sub-workflow: verify `{claims, skeptics?}` with skeptic juries; returns verified/dropped/votes/coverage. | A verification building block for a parent workflow. |
| `adversarial-plan-review` | N fixed-angle reviewers (correctness, security, maintainability, scope) synthesize a revised plan. | Design/RFC review; pre-implementation gate. |

## 🎯 Generate & select

| Workflow | What it does | Use cases |
| --- | --- | --- |
| `judge-escalate` | Generate candidates from distinct angles, typed judge, escalate only when confidence is low. | Best-of-N where you'd rather deepen than commit to a weak winner. |
| `tournament` | Single-elimination bracket: pairwise judge rounds until one candidate survives. | Pick the best of several drafts/designs when absolute scoring is unreliable but pairwise is easy. |
| `self-consistency` | Sample N independent reasoning paths, pick by consensus (vote), tie-broken by an evidence-weighing judge. | High-variance reasoning/math/judgment; report the consensus margin. |
| `tree-of-thoughts` | Beam search over partial solutions: expand K thoughts, judge-score, prune to top-B, recurse to depth, commit. | Multi-step planning/design search; explore a solution space. |

## 🔁 Iterate & refine

| Workflow | What it does | Use cases |
| --- | --- | --- |
| `self-refine` | Bounded in-place generate → critique → refine with verbal memory; quiet-stop when the critic is satisfied. | Polish one artifact (doc/spec/code) to quality. |
| `reflexion` | Verbal-RL outer trial loop: re-attempt each trial carrying self-reflections; evaluator can be externally grounded (`verifyCmd`). | Code-with-tests; tasks with a pass/fail oracle; reset-and-re-attempt vs edit-in-place. |

## 🚚 Migrate

| Workflow | What it does | Use cases |
| --- | --- | --- |
| `large-migration` | A real applier: green-baseline gate, per-file apply → verify → bounded-repair, rollback on failure. Sequential. | API/codemod rollouts; framework upgrades; capped, evidence-backed migration. |

## 🧩 Compose & meta

| Workflow | What it does | Use cases |
| --- | --- | --- |
| `composition-driver` | Parent workflow: discover claims, delegate verification to `verify-claims-lib`, then synthesize. | Fact-check a document; the canonical discover→verify composition reference. |

---

## Next steps

- Keep this in sync when scaffolds are added/removed: re-run `dynamic_workflow action=scaffold` and diff the names against `extensions/pi-dynamic-workflows/scaffolds/*.js`.
- For per-workflow input shapes and primitives, see the live catalog output (each entry lists a sample `Input` and `Primitives`).
