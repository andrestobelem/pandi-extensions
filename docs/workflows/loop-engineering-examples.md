# Loop-engineering example workflows

Date: 2026-06-28

Two committed, runnable dynamic workflows that operationalize the
[loop-engineering investigation](../research/2026-06-28-loop-engineering.md)
(usage how-to in [loop-engineering-with-extensions.md](../loop-engineering-with-extensions.md)).
They are example **scaffolds** — pattern references you can run as-is, copy, or
adapt — not canned jobs.

Both encode the same one-line lesson on two different shapes:

> **Bound the loop AND keep the critique signal independent and unbiased.**

A model that judges its own work is unreliable (Huang et al., arXiv:2310.01798),
so the generator/finder never closes the loop — a **separate, read-only verifier**
does, and only on evidence.

## Files

| Workflow | File | Shape |
| --- | --- | --- |
| `loop-engineering-verified-refine` | `.pi/workflows/loop-engineering-verified-refine.js` | Bounded **refine** loop closed by an independent verifier |
| `loop-engineering-converge-verify` | `.pi/workflows/loop-engineering-converge-verify.js` | Bounded **discovery** that settles on quiet rounds, then verifies each finding independently |

Both are safe to run anywhere: **read-only tools only, no repo file edits**.
Every round (drafts, verdicts, findings, reports) is persisted as run-directory
artifacts, so the whole loop is inspectable.

## 1. `loop-engineering-verified-refine`

A `generate → independent-verify → refine` loop over a text artifact. The
GENERATOR proposes and revises; a SEPARATE reviewer persona emits
`VERDICT: PASS | FAIL` against the success criteria, and **only an independent
PASS stops the loop** — the same architecture as the `/goal` extension's
`verifying-independent` state, as a reusable workflow.

Run it:

```bash
/workflow run loop-engineering-verified-refine {"task":"Write a precise PR description for the last commit","criteria":"covers what/why, lists files, no claims without evidence"}
```

Input: `{ task, criteria?, draft?, maxRounds?=4, context? }`.

Principles it demonstrates (research §4):

- **Bounded termination** — `maxRounds`, never an infinite loop.
- **Actuator clamp** ("don't trust the model") — `maxRounds` saturated to `[1, 8]`
  (Self-Refine caps experiments at 4).
- **Convergence on evidence** — stops on an independent PASS, not a self-declaration.
- **Oscillation guard** — an identical blocking critique two rounds running flips to
  `BLOCKED` (a hard switch count, not better tuning).
- **Independent, unbiased critique** — the verifier "did not write this; judge it".
- **No silent caps** — logs when it stops at `maxRounds` without a PASS.

## 2. `loop-engineering-converge-verify`

The discovery-axis companion. Phase 1 fans out finders until `quietRounds`
consecutive rounds surface nothing new (settle-to-tolerance), bounded by
`maxRounds`. Phase 2 then requires **each** surviving finding to pass an
independent skeptic (guilty until proven) before it is reported — the finder
never confirms its own finding.

Run it:

```bash
/workflow run loop-engineering-converge-verify {"target":"extensions/pi-loop","what":"unsafe assumptions or unbounded loops"}
```

Input: `{ target?=".", what?, finders?=3, quietRounds?=2, maxRounds?=6 }`.

Principles it demonstrates:

- **Bounded termination** — `maxRounds` caps the discovery loop.
- **Convergence (quiet rounds)** — stops after `quietRounds` rounds with no new finding.
- **Actuator clamp** — `finders` / `quietRounds` / `maxRounds` saturated; concurrency
  clamped to `ctx.limits` (and the clamp is logged).
- **Budget-aware fan-out** — the verification phase verifies at most
  `maxAgents - findersUsed - 1` findings so a large finding count never blows the
  run's agent budget mid-flight; deferred findings are logged, never dropped.
- **Independent critique** — a per-finding skeptic (reviewer), not the finder.
- **Conservative verdict** — a missing/invalid skeptic verdict counts as refuted.
- **No silent caps** — logs the `maxRounds` stop, failed/unparsed finders, the clamp,
  and any budget deferral.

Finder output is parsed with a tolerant extractor (recovers bare or ```json-fenced
arrays) rather than a schema: a schema on a slow exploration agent turned occasional
empty streams into multi-retry stalls in testing. Audit subagents run with
`includeExtensions: false` (read-only repo work needs no web search).

## How these relate to the catalog scaffolds

These examples are deliberately **distinct** from the built-in pattern catalog
(`dynamic_workflow action=scaffold`):

- `loop-until-done` converges on quiet rounds but has **no** per-finding
  independent gate; `converge-verify` adds one.
- `adversarial-verify` votes a jury per finding but has **no** quiet-round
  discovery convergence; `converge-verify` adds it.
- The catalog has no bounded **refine** loop closed by an independent verifier;
  `verified-refine` fills that gap (the workflow analogue of `/goal`).

Use the catalog scaffolds for the common shapes; reach for these when you want
the loop-engineering guarantees (bounded + independent verification) made
explicit.

## Validation

Both files were statically validated with `dynamic_workflow action=graph`
(topology parses; no syntax errors) and exercised end-to-end with small smoke runs.
`verified-refine` converged on an independent PASS in one round; `converge-verify`
was hardened through real runs that surfaced three robustness bugs (silently dropped
prose-wrapped JSON, schema retry stalls, and a `maxAgents` overflow), all fixed and
re-verified. Re-run them yourself from the repo root; size `maxAgents` for
`finders × maxRounds + findingsToVerify + 1`.

## See also

- [Loop engineering with our extensions (how-to)](../loop-engineering-with-extensions.md)
- [Loop engineering — a source-backed investigation](../research/2026-06-28-loop-engineering.md)
- [Agentic patterns and papers applicable to Dynamic Workflows](../research/2026-06-25-agentic-patterns-papers-workflows.md)
