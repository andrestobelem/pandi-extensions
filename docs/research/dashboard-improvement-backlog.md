# Dashboard improvement backlog

Canonical list of pending/closed items for the `/workflow` TUI dashboard improvement
loop. Narrative of each pass lives in `dashboard-improvement-log.md`; this file is the
single source of truth for what's still open. Each item: stable id, title, why, real
paths (verified to exist), and status (`open` / `done` / `human`).

## Done

- **DW-DASH-001 — Extract shared "Selected agent" detail helper** · `done`
  - Why: the detail block was duplicated near-identically in two render paths, so any
    field-format edit risked silent divergence between Monitor and Agents.
  - Paths: `extensions/pi-dynamic-workflows/workflow-dashboard.ts`
    (`renderSelectedAgentDetail`), `extensions/pi-dynamic-workflows/tests/integration/dashboard-selected-agent-detail.test.mjs`.
- **DW-DASH-002 — Pin switch-session arg quoting/parsing round-trip** · `done`
  - Why: `parseWorkflowCommandArgument` (the `switch-session` arg path) had zero
    coverage; a naive quote-strip would break session paths containing spaces/unicode.
  - Paths: `extensions/pi-dynamic-workflows/tests/integration/switch-session-arg-roundtrip.test.mjs`,
    `extensions/pi-dynamic-workflows/dashboard-orchestration.ts` (exports the helper).
- **DW-DASH-003 — Collapse the duplicated per-row agent line formatting** · `done`
  - Why: `renderMonitorAgents` and `renderAgents` built the per-row chip suffix
    `prompt schema tools skills extensions keys` byte-for-byte identically with
    duplicated `muted(...)`/`success(...)`/`warning(...)`/`error(...)` expressions;
    only the prefix label/elapsed-vs-workflow segment and Monitor's `code:` chip
    differed. Extracted a behavior-preserving private helper `renderAgentRowMeta(...)`
    invoked from both render paths so the common chip string is built in one place.
  - Paths: `extensions/pi-dynamic-workflows/workflow-dashboard.ts`
    (`renderAgentRowMeta`, used in `renderMonitorAgents` and `renderAgents`),
    `extensions/pi-dynamic-workflows/tests/integration/dashboard-agent-row-meta.test.mjs`.
- **DW-TOOL-001 — Make the workflow HTML previewer compatible with BOTH harnesses** · `done`
  - Why: `build-workflow-artifact.mjs` (identical in `.pi/scripts/` and `.claude/scripts/`)
    only handled Claude-style top-level scripts; ctx-style / export-default / CommonJS
    workflows errored ("Unexpected token 'export'" / "module is not defined") and captured
    0 nodes, so the HTML preview was empty for `.pi/workflows/*.js`.
  - Resolution: the builder now rewrites `export default …` → `globalThis.__default`, provides
    a CommonJS `module` stub, and after the body runs CALLS the captured entry with a recording
    `ctx` whose methods alias the same stubs (helpers kept inside the `ctx` object so they never
    collide with scaffolds' own `const compact`). Verified: `continuous-improvement` 0→5 nodes,
    `loop-engineering-*` now run, all Claude scaffolds unchanged (no regression), both copies
    kept byte-identical. The throwaway adapter `.pi/tmp/build-ctx-workflow-html.mjs` was removed.
  - Paths: `.pi/scripts/build-workflow-artifact.mjs`, `.claude/scripts/build-workflow-artifact.mjs`.
- **DW-DASH-H1 — Confirm the new gate baseline (HEAD moved)** · `done` (resolved)
  - Resolution: the gate baseline is now pinned at `HEAD == da0a449` with a clean
    working tree and no foreign dirty files. The earlier `fad9875`/`9010157` concern no
    longer applies; this item is moot at the current baseline.
  - Paths: `.git/refs/heads/main` (current `da0a449`).
- **DW-DASH-H2 — Own/format/keep the collectors contract test** · `done` (resolved)
  - Resolution: `dashboard-collectors-contract.test.mjs` is now tracked and committed
    (not untracked), so the provenance concern is gone. It runs green in the
    auto-discovered verify loop and passes `biome check`; no further human decision is
    needed.
  - Paths: `extensions/pi-dynamic-workflows/tests/integration/dashboard-collectors-contract.test.mjs`.
- **DW-DASH-H3 — Jump-to-next-active-run shortcut in Runs/Activity** · `done`
  - Why: a keybinding to jump to the next active run speeds monitoring of long lists.
  - Resolution: implemented WITHOUT touching the hot `index.ts`. The dashboard owns all
    in-component navigation in `workflow-dashboard.ts handleInput` (`index.ts` only
    registers `Ctrl+Alt+W` to open it), so the original "likely touches index.ts"
    assumption was wrong. `]` / `[` now jump selection to the next/previous **running**
    run on the Runs tab and the next/previous running entry on the Activity tab (wrapping;
    no-op when nothing is running), mirroring the Monitor's `[` / `]` cycling and the
    Agents tab's `f`. Anchored by `dashboard-jump-active-run.test.mjs` (9 checks); help
    overlay + per-tab help bar updated.
  - Paths: `extensions/pi-dynamic-workflows/workflow-dashboard.ts`,
    `extensions/pi-dynamic-workflows/tests/integration/dashboard-jump-active-run.test.mjs`.

## Open (in allow-set; safe to pick up next)

_None currently._

## Human (needs a decision; not auto-fixable in allow-set)

_None currently._

## Ideas requiring hot files (propose only — do NOT implement in autopilot)

_None currently._
