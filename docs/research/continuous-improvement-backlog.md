# Continuous-improvement backlog

Canonical list of OPEN pending items for the `pi-dynamic-workflows` package.

The `continuous-improvement` workflow (`.pi/workflows/continuous-improvement.js`) maintains
this file: it adds open items and flips resolved ones to `done` HERE, instead of burying
"Pending for future passes" notes inside the chronological log
(`continuous-improvement-log.md`). The log is the narrative of what happened each pass; this
backlog is the durable list of what is still open.

Conventions:

- Each item has a stable id, a one-line "why", real verified paths, and a status.
- Status: `open` (actionable by a pass) · `done` (resolved; keep briefly for traceability) ·
  `human` (needs a human decision the autopilot cannot make).
- When a pass resolves an item, mark it `done` with the date and the resolving commit/files;
  do not silently delete it.
- Before citing a path here, verify it exists; refresh stale references instead of copying old ones.

## Open (actionable)

### CI-1 — Add a second `lib/` driver to the recipe catalog

- Status: open
- Why: `composition-driver` / `compose-verify-claims` only cite `lib/verify-claims`, yet
  `lib/rank-candidates` shows composition is a general pattern. A second driver makes that explicit.
- Where: `extensions/pi-dynamic-workflows/templates.ts` (the `compose-verify-claims` /
  `verify-claims-lib` entries).

### CI-2 — Harden `/goal` non-interactive rehydrate + add a durable e2e

- Status: open
- Why: the rehydrate path for `/goal` in non-interactive mode is a known gap; needs a dedicated
  integration test.
- Where: `extensions/pi-goal/index.ts`, `extensions/pi-goal/tests/integration/`.

### CI-3 — Promote the composition-failure-recursion suite when stable

- Status: open
- Why: it is still excluded as a draft; move it into the durable manifest once it is reliably green.
- Where: `scripts/test/run-all.mjs` (`ignoredDraftSuites` → `suites`),
  `extensions/pi-dynamic-workflows/tests/integration/composition-failure-recursion.test.mjs`.

### CI-4 — Refresh stale path references in the chronological log

- Status: open
- Why: `continuous-improvement-log.md` cites old paths (`examples/e2e/...`, `goal.ts`, `loop.ts`,
  `plan.ts`); the current layout is `extensions/pi-*/index.ts` + `scripts/test/run-all.mjs`.
- Where: `docs/research/continuous-improvement-log.md`.

### CI-5 — Re-run agentic-research for a clean 7/7 coverage when `web_search` budget is free

- Status: open
- Why: the workflow is fixed (per-topic `{name,ok,output}` synthesis input + string-input guard),
  but three runs capped at 6/7, 3/7 and 4/7 because concurrent sessions exhausted the shared
  `web_search` budget. Re-run with a single active writer to get clean 7/7 coverage.
- Where: `.pi/workflows/agentic-workflow-patterns-research.js` (fixed in commits f36226b, 132af53).

## Deferred (separate plans — `/bg` feature, see `docs/memoria.md` 2026-06-26)

### BG-1 — Supacode runner

- Status: open

### BG-2 — `background_job` LLM tool

- Status: open

### BG-3 — Daemon / automatic rehydrate of background jobs

- Status: open

### BG-4 — Prune/delete + `/bg` dashboard

- Status: open

## Human decisions (autopilot cannot resolve)

### H-1 — Publish / register the package and extensions

- Status: human
- Why: irreversible; outside autopilot scope.

### H-2 — Push local commits to `origin`

- Status: human
- Why: no implicit push; pushing local commits is a deliberate human action.

### H-3 — Decide whether to de-contaminate commit `e2e23b3`

- Status: human
- Why: a shared `.git/index` race (two agents in one worktree) swept 5 unrelated files
  (`extensions/pi-dynamic-workflows/index.ts` + `README.md`, `.pi/skills/dynamic-workflows/SKILL.md`,
  `scripts/test/run-all.mjs`, a test rename) into the pi-bg commit `e2e23b3`. Content is correct;
  only the grouping is non-atomic. Cleaning needs a rebase rewriting ~33 commits (≈26 foreign) →
  risky; accepted as-is for now.

### H-4 — Run a single writer per worktree

- Status: human
- Why: concurrent agent sessions in this worktree caused the `e2e23b3` index contamination,
  blocked the `e2e23b3` rebase (shared history kept moving), and exhausted the shared `web_search`
  budget during research re-runs. Use one writer per worktree (or separate worktrees).
