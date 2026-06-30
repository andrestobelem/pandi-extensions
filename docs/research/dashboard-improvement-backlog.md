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

- **DW-TOOL-001 — Fix the workflow HTML previewer for ctx-style workflows** · `open`
  - Why: `.pi/scripts/build-workflow-artifact.mjs` only introspects *globals-style*
    workflows (`export default async function main()` calling the injected `agent()`).
    For *ctx-style* workflows (`export default async function workflow(ctx, input)`
    calling `ctx.agent(...)`, e.g. `continuous-improvement.js`) it errors with
    "Unexpected token 'export'" and captures 0 agent nodes — the HTML preview comes out
    empty. Workaround used this pass: a throwaway adapter at
    `.pi/tmp/build-ctx-workflow-html.mjs` that imports the workflow as an ES module and
    runs it against recording `ctx` stubs (5 roles captured). The builder should support
    BOTH styles (detect `export default`, import the module, and inject a recording
    `ctx` whose methods alias the stubbed globals).
  - Paths: `.pi/scripts/build-workflow-artifact.mjs` (the shared previewer to fix),
    `.pi/tmp/build-ctx-workflow-html.mjs` (throwaway reference adapter).

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
