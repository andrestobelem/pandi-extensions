# Dashboard improvement backlog

Canonical list of pending/closed items for the `/workflow` TUI dashboard improvement
loop. Narrative of each pass lives in `dashboard-improvement-log.md`; this file is the
single source of truth for what's still open. Each item: stable id, title, why, real
paths (verified to exist), status (`open` / `done` / `human`).

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

## Open (in allow-set; safe to pick up next)

_None currently open in the allow-set._

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

## Human (needs a decision; not auto-fixable in allow-set)

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

## Ideas requiring hot files (propose only — do NOT implement in autopilot)

- **DW-DASH-H3 — Jump-to-next-active-run shortcut in Runs/Activity** · `human`
  - Why: a keybinding to jump to the next active run would speed monitoring, but wiring
    a new key/command likely touches the hot `index.ts` (command/keymap registration),
    which is outside the allow-set. Propose here; implement only with explicit human
    approval to edit `index.ts`.
  - Paths: `extensions/pi-dynamic-workflows/index.ts` (hot — do not edit),
    `extensions/pi-dynamic-workflows/workflow-dashboard.ts` (input handling).
