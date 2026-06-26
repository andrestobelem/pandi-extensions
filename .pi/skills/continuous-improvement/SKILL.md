---
name: continuous-improvement
description: >-
  Use to run a self-verifying CONTINUOUS-IMPROVEMENT pass or loop on THIS pi-dynamic-workflows
  package — when asked to "improve the package", "harden the extensions/tests", "do an
  improvement pass/loop", or "iterate until there's nothing safe left". Drives the project-local
  `continuous-improvement` dynamic workflow (implement → adversarial review → verify, gated by a
  real test run), never committing or pushing. Not for one-off edits or generic goals (use /goal).
---

# Continuous improvement (this package)

A goal-style, self-verifying improvement LOOP for the `pi-dynamic-workflows` repo, implemented as a
project-local dynamic workflow at `.pi/workflows/continuous-improvement.js`. It is separate from the
generic `/goal` extension: `/goal` pursues any objective; this drives repeated, safeguarded
improvement passes over THIS package and stops when nothing safe is left.

## When to use it
- "Mejorá / improve this package", "do an improvement pass", "harden the extensions or tests", "iterate until dry".
- You want real, verified changes with adversarial review, NOT just a plan.

Do NOT use it for: a single specific edit/bugfix (just do it), or a generic non-improvement objective
(use `/goal <objective> -- <criteria>`).

## How to run it
From the **repo root**, with the project **trusted** (project-scope `.pi/workflows/` is trust-gated):

```
/workflow start continuous-improvement {"maxPasses":1}
```

- `start` runs it in the background — watch with `/workflow runs` and `/workflow view`. `run` is the foreground (blocking) variant.
- Start with `maxPasses: 1` to see one full pass before letting it run longer.

Input (all optional):
- `maxPasses` (default 3) — hard upper bound on passes.
- `objective` — raw goal; a meta-step refines it into a sharp driving prompt before iterating.
- `allow` — editable simple globs (`*`/`**`; default `extensions/loop/**`, `extensions/goal/**`, `extensions/plan/**`, `extensions/bg/**`, `extensions/effort/**`, `scripts/test/run-all.mjs`, `docs/**`). Narrow it (e.g. `["docs/**"]`) for the lowest-risk first test.
- `hotFiles` — never-edit paths (default `extensions/dynamic-workflows/index.ts`).
- `verifyCmd` (default `npm test`) — the objective green/red check that gates each pass.
- `logPath` (default `docs/research/continuous-improvement-log.md`) — the progress log it appends to.

## What each pass does
1. **Meta-step (once):** refine the raw objective into a driving prompt (criteria, allowed/hot files, verify commands) by reading the repo, read-only.
2. **Implement:** pick the single highest value/(cost·risk) safe improvement and apply it, only within `allow`.
3. **Adversarial review:** two reviewers (correctness/regression + value/safeguards) flag blockers.
4. **Verify:** the workflow runs a safety gate before `verifyCmd`, runs `verifyCmd`, then runs safety again; a RED check, `HEAD` change, outside-allow edit, or protected-file change forces the pass to `BLOCKED` (it never continues on red). It appends a log entry when the log file was clean/allowed at start.

It stops early on `DRY` (nothing safe left) or `BLOCKED` (needs a human), else after `maxPasses`.

## Safeguards (and your job after)
- NEVER edits `hotFiles` or files with foreign uncommitted changes; for those it only proposes in `docs/`.
- If it adds durable suites under `tests/**`, the default allowlist also permits `scripts/test/run-all.mjs` so the manifest can stay consistent.
- Does NOTHING irreversible: no push, no `rm -rf`, no deleting/committing others' work; the safety gate blocks if `HEAD` changes.
- **It does NOT commit.** When it finishes, the working tree has uncommitted edits — REVIEW them (`git diff`, the run's `driving-prompt.md` / `continuous-improvement.json` artifacts via `/workflow view`) and **commit yourself**, or discard with `git checkout --` / `git clean -fd`.

## Note on installed use
This workflow is project-local (it names this repo's files and `npm test`). When the package is
installed elsewhere, the `/workflow` + `/goal` machinery travels, but you'd author a project-specific
`continuous-improvement` workflow in that repo's `.pi/workflows/` pointing at its own files.
