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

### CI-6 — Monitor height budget (adaptive windowing that keeps the detail visible)

- Status: open
- Why: `WorkflowDashboard.render(width)` receives no terminal height, so on short
  terminals (e.g. 80×24) the Monitor's metadata labels + agent list + "Selected agent"
  detail overflow and the detail falls below the fold. Needs adaptive per-tab windowing
  that shrinks the list while keeping the selected detail on screen — the live viewer
  already does this via `getHeight()`/`pageSize()`. A blind bottom-clamp would be theater
  (it would hide the very detail the user wants), so this is deferred until it can be done
  properly. From the dashboard UX review; the rest of that review's P1–P3 items already
  landed (commits 6dc5876, e04598e, e446f2d, 8fe2842, dc47503, 697d5ce, bbfaa18, 612623a).
- Where: `extensions/pi-dynamic-workflows/index.ts` (`class WorkflowDashboard` constructor +
  `render`/`renderMonitor`; mirror `AgentLiveViewComponent.pageSize()`), the
  `ctx.ui.custom` factory in `openWorkflowDashboard` (pass `() => tui.terminal.rows`), and
  parametrize the hardcoded `terminal: { rows: 30 }` in
  `extensions/pi-dynamic-workflows/tests/integration/dashboard-usability-fixes.test.mjs` to
  cover 24/50 rows.
- Note: changes the `WorkflowDashboard` constructor signature — best done when `index.ts`
  is not being edited concurrently (see H-4).

### CI-7 — Reuse Pi TUI primitives instead of hand-rolled list/help code

- Status: open
- Why: the dashboard hand-rolls window math in ~6 per-tab renderers (different magic
  offsets) and swaps the whole screen for `?` help; Pi already ships `SelectList`
  (windowing, scroll info, `setFilter`/`enableSearch`, `setSelectedIndex`) and overlays
  (`ctx.ui.custom(..., { overlay: true })`) plus a keybindings manager. Reuse would remove
  off-by-one risk, add a `/` filter on Agents/Runs, and make `?`/detail a non-destructive
  overlay. Evaluate against the existing identity-stable selection (`reselectIndexByKey`)
  and per-line truncation before adopting; larger refactor, so scoped as a separate pass.
- Where: `extensions/pi-dynamic-workflows/index.ts` (`renderRuns`/`renderAgents`/
  `renderWorkflows`/`renderPatterns`/`renderSessions` window slices and `renderHelp`);
  reference `docs/tui.md` (SelectList/SettingsList/overlays/keybindings).

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
