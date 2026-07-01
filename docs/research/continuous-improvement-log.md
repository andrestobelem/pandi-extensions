# Continuous improvement loop — progress log

External memory for the autonomous loop (Reflexion-style). One entry per pass. Driven by
`docs/planes/loop-mejora-continua-prompt.md`. DO NOT repeat paths already tried/discarded without re-verifying.

---

## Pass 1/8 — 2026-06-25

**Baseline:** `npm test` (`tsc` for the 4 extensions) **green** at the start.

**Hot files detected (do not touch):** `extensions/dynamic-workflows.ts` (mtime moved from
07:28 → 07:36 during this pass → ANOTHER session actively editing it) and `examples/workflows/{adversarial-plan-review,deep-research,repo-bug-hunt}.js` (already modified and uncommitted at the start; not mine). Respected: I did not touch them.

**CHOSEN improvement:** *durable behavioral e2e for the loop/plan SAFETY GATES*.
New file (ours only, not hot): `examples/e2e/safety-gates.e2e.mjs`.

- **Observed problem (evidence):** `package.json` `scripts.test` is ONLY `tsc --noEmit` → zero
  behavioral coverage. The most critical safety parts are pure gate predicates:
  `plan.ts` `blockedReason`/`isMutatingBash` (read-only gate) and `loop.ts`
  `destructiveReason`/`isDestructiveBash`/`isUnsafeWritePath` + the `loop_schedule` clamp to `[60,3600]`.
  A silent regression there = a real safety hole (an autonomous loop running `rm -rf`, or plan
  mode allowing an `edit`) and `tsc` does not detect it. Previous sessions wrote equivalent e2e tests
  but they stayed in the disposable scratchpad (evidence: `loop-e2e.mjs`, `plan-e2e.mjs`, `goal-e2e.mjs`
  in the scratchpad; the parity plan references "the e2e harness (scratchpad) that already validates resume")
  → they were lost between sessions, with zero durable protection.
- **Why this and not others:** highest value/(effort·risk). Risk ~zero (new file, does not touch the
  hot core, does not change extension runtime). High and durable value: blocks regressions in
  safety gates forever, in-repo, runnable from a clean checkout.
- **Discarded:** (i) proposing changes to core `dynamic-workflows.ts` → it is the hot file, only
  PROPOSALS are allowed, and there was no concrete observed defect justifying a proposal this
  pass; (ii) cosmetic refactors in loop/goal/plan → without an observable defect, they would count as theater;
  (iii) e2e coverage for `goal.ts` (verifier/`parseVerdict`) → good candidate but higher effort
  (spawns `pi -p` subprocess); deferred to the next pass to keep ONE coherent, bounded improvement.

**E2E design:** self-bootstrapping. It builds the CURRENT `extensions/{loop,plan}.ts` with esbuild into a tempdir
(never copies stale code), aliases `typebox` and `@earendil-works/pi-coding-agent` to local stubs (so it runs
without `npm install`), and imports the real ESM to drive the real registered handlers/tools against a
mocked `pi`/`ctx`. It asserts the OBSERVABLE CONTRACT (block vs allow, clamped delay), not copies of the
regexes → tracks the source.

**Adversarial verification + anti-theater:**
- 61/61 checks PASS against the real source.
- **Fault injection (proof it is NOT theater):** I copied loop.ts/plan.ts to a temporary repo, removed
  the `\brm\b` pattern from the `plan.ts` copy, and the suite went RED (exit 1, exactly failing
  `plan: BLOCKS bash "rm -rf x"`, 60/61). With clean source: green. ⇒ detects real regressions.
- I detected and fixed my own defect: the process stayed hanging after the green run (loops leave
  live `setTimeout` timers). Fix: explicit `process.exit(0)` on the success path. Re-verified
  clean EXIT=0.

**Verification commands (all green):**
- `npm test` → EXIT 0 (`tsc` for the 4 extensions).
- `node --check examples/e2e/safety-gates.e2e.mjs` → OK.
- `npx esbuild extensions/{loop,plan}.ts ...` → bundle OK.
- `node examples/e2e/safety-gates.e2e.mjs` → `TOTAL: 61 passed, 0 failed`, EXIT 0.

**Files touched (absolute paths):**
- NEW: `examples/e2e/safety-gates.e2e.mjs`
- NEW (this log): `docs/research/continuous-improvement-log.md`

**Type of change:** REAL (new file, behavior verified and fault-injected). Not a proposal.

**Pending for upcoming passes:**
1. Extend e2e coverage to `goal.ts`: the independent verifier and `parseVerdict` (parsing the
   skeptical subagent verdict — a wrong parse = false "done"). Higher effort (subprocess).
2. Evaluate whether a single runner (`examples/e2e/run-all.mjs`) or wiring to an npm script is worthwhile — NOTE:
   `package.json` is NOT in the editable allowlist, so wiring into `npm test` would require a human
   decision / handoff; for now e2e tests are run manually (`node examples/e2e/*.e2e.mjs`).
3. Docs↔code: confirm README/SKILL.md mention how to run the e2e tests (minor gap).
4. Check whether the parity plan still has OUR gaps (not in the hot core) that remain unimplemented.

---

## Pass 2/8 — 2026-06-25

**Baseline:** `npm test` (`tsc` for the 4 extensions) **green** at the start (EXIT 0).

**Hot files detected (do not touch):** `extensions/dynamic-workflows.ts` — still HOT
(another active session: mtime/size moved DURING the pass: 07:36/246371B → 07:39/246675B). Only
propose; I did not touch it. The rest of our extensions are stable and without diff: `goal.ts` (mtime
06:27, +1h), `loop.ts` (06:32), `plan.ts` (06:48) → NOT hot. My only new file is in
`examples/e2e/` (untracked, mine). No conflict.

**CHOSEN improvement (pending #1 from the previous log):** *durable behavioral e2e for the INDEPENDENT
VERIFIER in `goal.ts`* (where a wrong verdict parse = false "done"). New file (ours only, not hot):
`examples/e2e/goal-verifier.e2e.mjs`.

- **Observed problem (evidence):** `goal.ts:354 parseVerdict` + `goal.ts:388 runIndependentVerifier`
  + the `beginIndependentVerification` state machine (`goal.ts:650`) are the point where the package
  decides whether a goal is really "done". A silent regression there (closing on an ambiguous/malformed
  verdict, trusting a prompt echo containing `VERDICT: PASS`, or closing despite exit≠0)
  = a FALSE "done" that closes an UNverified goal: exactly the failure the verifier exists to
  prevent. `tsc` sees none of this (it is string logic + state machine). Previous sessions wrote an
  equivalent `goal-e2e.mjs`, but it stayed in the disposable scratchpad (lost between sessions). This
  is the durable commit that was missing, recorded as pending #1 in Pass 1.
- **Why this and not others:** highest value/(effort·risk). It was the explicit pending #1. Risk
  ~zero (new file, does not touch the hot core, does not change runtime). The effort turned out to be S, not M:
  there was NO need to spawn real `pi -p` — the OBSERVABLE contract is handled by mocking `pi.exec`
  (the subprocess boundary) and driving the real tools/command; the real subprocess adds no coverage, only
  fragility.
- **Discarded:** (i) proposing to core `dynamic-workflows.ts` → still hot and I did not observe a concrete
  defect justifying a proposal this pass; (ii) single runner / wiring to `npm test` (pending #2)
  → `package.json` is NOT in the editable allowlist; it requires a human decision/handoff, not touched on
  autopilot; (iii) docs for how to run e2e (pending #3) → minor gap, cosmetic, not high value.

**E2E design:** same proven self-bootstrapping pattern as `safety-gates.e2e.mjs`. It builds the CURRENT
`extensions/goal.ts` with esbuild into a tempdir (never stale), aliases `typebox`/`@earendil-works/pi-coding-agent`
to local stubs (runs without `npm install`), and drives the REAL `/goal` command + `goal_progress` tool
against a mocked `pi`/`ctx`. It asserts the observable OUTCOME (the final `gstatus` persisted via
`pi.appendEntry("goal-state", …)`: done / blocked / continue→pursuing), NOT copies of the regex. Covers 7
scenarios: PASS-closes, FAIL-iterates-then-blocks-at-cap, malformed/missing=conservative FAIL (6
subcases), **prompt-echo attack** (PASS appears above as an instruction but the final verdict
is FAIL → must not close; symmetric positive control: final PASS DOES close despite the echo), exit≠0+PASS=FAIL,
timeout(killed)/throw=FAIL, and the first `done` never closes or fires the verifier (two-step gate).

**Adversarial verification + anti-theater:**
- 30/30 checks PASS against the real source (EXIT 0).
- **Fault injection (proof it is NOT theater):** I copied `goal.ts` to a temporary repo and replaced the
  body of `parseVerdict` with a NAIVE parser ("any PASS anywhere wins" — the exact regression
  the design protects against). The suite went RED: **24/30, 6 failures**, EXIT 1, failing
  precisely on the dangerous cases: the prompt echo closed as `done`, malformed `VERDICTPASS`
  and "pass" in prose closed as `done`. With clean source: green. The positive control (genuine final
  PASS) kept closing in both → the suite distinguishes real signal from false positive. ⇒ detects

real regressions at the safety point.
- No regression in the Pass 1 suite: `safety-gates.e2e.mjs` remains 61/61.

**Verification commands (all green):**
- `npm test` → EXIT 0 (tsc for the 4 extensions).
- `npx esbuild extensions/goal.ts --platform=node --format=esm --packages=external …` → bundles OK.
- `node --check examples/e2e/goal-verifier.e2e.mjs` (and safety-gates) → OK.
- `node examples/e2e/goal-verifier.e2e.mjs` → `TOTAL: 30 passed, 0 failed`, EXIT 0.
- `node examples/e2e/safety-gates.e2e.mjs` → 61/61 (no regression).

**Files touched (absolute paths):**
- NEW: `examples/e2e/goal-verifier.e2e.mjs`
- THIS log: `docs/research/continuous-improvement-log.md`

**Type of change:** REAL (new file, behavior verified and fault-injected). Not a proposal.
**loop-until-dry counter:** 0 (this pass DID commit a high-value improvement). Passes used: 2/8.

**Pending for future passes (updated):**
1. ~~e2e for `goal.ts` verifier/parseVerdict~~ → DONE this pass.
2. Single runner / wiring into `npm test`: still BLOCKED by allowlist (`package.json` not editable in
   autopilot). Candidate for HANDOFF in docs/ if durable CI is wanted. Do not touch `package.json` alone.
3. Doc↔code: README/SKILL.md do not document how to run the e2e tests (`node examples/e2e/*.e2e.mjs`) — minor
   gap; evaluate whether it is worth a small docs improvement (editable) or whether it is cosmetic.
4. e2e behavior coverage still untouched in `loop.ts`/`goal.ts` BEYOND the gates/verifier:
   e.g. goal rehydration (`goal.ts:rehydrate`, recovery after reload — `verifying-independent`
   must RE-run the verifier) and the `goal_progress` `waitSeconds` clamp ([60,3600]). Re-verify
   the real state before choosing; measure whether there is an observable defect or if it is theater.
5. Review whether the parity plan (`docs/planes/2026-06-25-paridad-claude-dynamic-workflows.md`) has
   OUR gaps (not in the hot core) still unimplemented.

### Closeout of Pass 2/8 — 2026-06-25 (finalization + re-verification)

Adversarial reviews R0 and R1: **PASSED, no blockers**. There were no fixes to apply
(tree already green). Final re-verification of this closeout pass (exit codes without pipe):
- `npm test` (tsc 4 extensions) → **EXIT 0** (green).
- `npx esbuild extensions/goal.ts --platform=node --format=esm --packages=external` → **EXIT 0** (bundles OK).
- `node --check examples/e2e/goal-verifier.e2e.mjs` and `…/safety-gates.e2e.mjs` → **OK**.
- `node examples/e2e/goal-verifier.e2e.mjs` → **30/30, EXIT 0**.
- `node examples/e2e/safety-gates.e2e.mjs` → **61/61, EXIT 0** (no regression).

Safeguards: hot core `extensions/dynamic-workflows.ts` left intact by me (mtime 07:47:08,
grew to 260687B during the other session’s activity — still HOT; propose only, do not edit).
`git status --porcelain` for our work: only untracked (`examples/e2e/`, this log,
`docs/planes/loop-mejora-continua-prompt.md`); `goal.ts`/`loop.ts`/`plan.ts` with no diff. No commit, no push.

---

## Pass 3/8 — 2026-06-25

**Baseline:** `npm test` (tsc for the 4 extensions) **green** at start (EXIT 0).

**Hot files detected (do not touch):** `extensions/dynamic-workflows.ts` — STILL HOT (another
active session: mtime moved DURING the pass, 07:47 → 07:55:22). Propose only; I did not touch it.
`goal.ts` (mtime 06:27:48, no diff), `loop.ts` (06:32), `plan.ts` (06:48) → NOT hot. My only
new file is in `examples/e2e/` (untracked, mine). No conflict.

**Improvement CHOSEN (pending item #4 from prior log + explicit high-value candidate):** *durable behavior e2e for
REHYDRATION (recovery after crash/reload) of `goal.ts`* — the
`rehydrate()` path triggered by `session_start`. New file (ours only, not hot):
`examples/e2e/goal-rehydrate.e2e.mjs`.

- **Observed problem (evidence):** `goal.ts:855 rehydrate` is the ONLY mechanism that revives a live goal
  when the process restarts, and its contract is entirely BEHAVIORAL (invisible to `tsc`).
  The most consequential case: `goal.ts:905-909` — a snapshot in `verifying-independent` (a goal that
  crashed IN THE MIDDLE of independent verification) must RE-run the skeptical subagent on reload
  (its in-flight verdict was lost → it is re-judged, not guessed). A silent regression there = the
  goal either silently falls over or closes WITHOUT verification — exactly the failure the verifier exists to
  prevent. Also: `stale`→`pursuing` (catch-up of ONE tick, not a burst), `verifying`→`verifying` (the
  self-check survives reload), terminals (`done`/`blocked`/`stopped`) are NOT recovered
  (`goal.ts:868-875`), last-wins by goalId (`:862`), no-double-fire (`:877`), and `fork`→no-op
  (`:1161`). Zero prior e2e coverage for all this.
- **Why this and not others:** highest value/(effort·risk). It was explicit pending item #4 and one of the
  named high-value candidates. Risk ~zero (new file, does not touch the hot core, does not change
  runtime). Effort S/M: reuses the already-proven self-bootstrapping pattern; handles the real
  `session_start` handler against a mocked `pi`/`ctx` with `sessionManager.getEntries()` returning fabricated
  `goal-state` snapshots (the real reload entry).
- **Discarded:** (i) proposing to core `dynamic-workflows.ts` → still hot, with no concrete defect
  observed this pass to justify a proposal; (ii) e2e for fixed loop/cron/FIFO/watchdog/clamp → good
  candidate but HIGHER effort (timers/cron, multi-loop FIFO); deferred to keep ONE bounded improvement
  and because goal rehydration was pending item #4 with direct evidence; (iii) doc↔code coherence in
  SKILL.md → minor/cosmetic gap, not high value; (iv) wiring into `npm test` → `package.json`
  outside allowlist (blocked, handoff candidate).

**e2e design:** same self-bootstrapping pattern as safety-gates/goal-verifier. Builds
the CURRENT `extensions/goal.ts` with esbuild into a tempdir (never stale), aliases `typebox`/SDK to local stubs (runs without
`npm install`), handles the REAL `session_start` handler and asserts the observable OUTCOME: which goals
activate, in what `gstatus`, whether it respawns the verifier (`pi.exec`), whether it reinjects wake
(`pi.sendUserMessage`), and the final persisted disposition. For `stale`/`verifying` it uses `nextFireAt` in
the PAST so the catch-up tick fires and proves the goal is GENUINELY active (persists
iteration+1 and reinjects exactly ONCE), with no tautological escape. 8 scenarios / **31 checks**:
verifying-independent RE-runs verifier (PASS→done; FAIL under cap→continue; FAIL at cap→blocked; never
false done); stale→pursuing (single wake); verifying→verifying (no downgrade, no verifier); terminals
NOT recovered (no exec/no wake/no new persist); last-wins by goalId (both directions); fork=no-op;
junk/foreign/malformed ignored without crash; no-double-fire on second session_start.

**Adversarial verification + anti-theater:**
- 31/31 checks PASS against the real source (EXIT 0).
- **Fault-injection #1 (proof that it is NOT theater):** copied `goal.ts` to a temporary repo and REMOVED the
  `verifying-independent` branch from `rehydrate` (re-arm normal timer instead of `beginIndependentVerification`
  — the exact silent regression). The suite went RED: **25/31, 6 failures**, failing precisely
  the `verifying-independent` contract checks (does not respawn verifier, does not close/block, last-wins
  re-run, junk-only-valid-recovers). With clean source: green. ⇒ detects the most dangerous regression.
- **Fault-injection #2 (honest finding about scope):** injected "recover EVERYTHING, incl. terminals".
  The suite stayed GREEN (31/31). Real and correct reason: a terminal snapshot has `nextFireAt:null` and
  `fireGoal` (`goal.ts:575`) immediately returns for every status ≠ pursuing/verifying →
  over-recovery is OBSERVABLY INERT (zero exec/wake/persist). My terminal checks pin the
  OBSERVABLE contract (finished goal = inert), which holds; they do NOT pin the internal filter.
  Documented limitation, not hidden: the mocked harness does not see `activeGoals` directly, and the
  observable guarantee (finished = inert) is what matters to the user.
- No regression in prior suites: `goal-verifier.e2e.mjs` 30/30, `safety-gates.e2e.mjs` 61/61.

**Verification commands (exit codes without pipe, all green):**
- `npm test` → **EXIT 0**.
- `npx esbuild extensions/goal.ts --platform=node --format=esm --packages=external` → **EXIT 0**.
- `node --check examples/e2e/{goal-rehydrate,goal-verifier,safety-gates}.e2e.mjs` → **OK**.
- `node examples/e2e/goal-rehydrate.e2e.mjs` → **31/31, EXIT 0**.
- `node examples/e2e/goal-verifier.e2e.mjs` → **30/30, EXIT 0** (no regression).
- `node examples/e2e/safety-gates.e2e.mjs` → **61/61, EXIT 0** (no regression).

**Files touched (absolute paths):**

- NEW: `examples/e2e/goal-rehydrate.e2e.mjs`
- THIS log: `docs/research/continuous-improvement-log.md`

**Type of change:** REAL (new file, verified and fault-injected behavior). Not a proposal.
**loop-until-dry counter:** 0 (this pass DID commit a high-value improvement). Passes used: 3/8.
**Safeguards:** hot core `dynamic-workflows.ts` left intact by me (mtime moved to 07:55:22 because of the
other session — still HOT). My only change: untracked `examples/e2e/goal-rehydrate.e2e.mjs`.
`goal.ts`/`loop.ts`/`plan.ts` with no diff. No commit, no push.

**Pending for future passes (updated):**
1. ~~goal rehydrate e2e (verifying-independent re-runs verifier)~~ → DONE (Pass 3).
2. ~~behavior e2e for `loop.ts` (fixed cadence, multi-loop FIFO, watchdog)~~ → DONE (Pass 4).
3. Wiring into `npm test` (single runner): still BLOCKED by allowlist (`package.json` not editable in
   autopilot). Candidate for HANDOFF in docs/ if durable CI is desired.
4. Doc↔code: README/SKILL.md do not document how to run the e2e tests (`node examples/e2e/*.e2e.mjs`) — minor
   gap; evaluate as a small docs improvement (editable) or cosmetic.
5. Review OUR gaps in the parity plan (`docs/planes/2026-06-25-paridad-claude-dynamic-workflows.md`),
   not the hot core.
6. e2e coverage still untouched in `loop.ts`: caps gate (maxIterations / wall-clock / context-percent
   stop the loop with status "done"), pause/resume (preserve remaining delay; resume dynamic vs fixed),
   loop rehydrate (stale→running with a single catch-up tick, paused remains paused, last-wins
   JSONL-vs-sidecar). The goal verifier and goal rehydration are already covered; this is the
   analogous work for loop.

---

## Pass 4/8 — 2026-06-25

**Baseline:** `npm test` (tsc for the 4 extensions) **green** at start (EXIT 0).

**Hot files detected (do not touch):** `extensions/dynamic-workflows.ts` — STILL HOT (another
active session: mtime moved DURING the pass, 07:56:49 → 08:00:42). Only propose; I did not touch it.
`goal.ts` (mtime 06:27:48, no diff), `loop.ts` (06:32:56, no diff), `plan.ts` (06:48:10, no diff) →
NOT hot. My only new file is in `examples/e2e/` (untracked, mine). No conflict.

**Improvement CHOSEN (pending item #2 from the previous log + explicit high-value candidate):** *durable
behavior e2e for the SCHEDULING ENGINE in `loop.ts`* — the part that decides WHEN and IN WHAT
ORDER autonomous iterations fire, distinct from the GATES (already covered by safety-gates) and the
`loop_schedule` clamp (already covered by safety-gates — NOT duplicated here). New file (only ours,
not hot): `examples/e2e/loop-behavior.e2e.mjs`.

- **Prompt vs. code clarification (evidence):** the candidate named "fixed/cron". The code does NOT have
  cron: cadence is fixed-interval (`^\d+(s|m|h)$`, `loop.ts:106 INTERVAL_RE` + `:271 parseInterval`)
  or dynamic (model-paced). I covered what ACTUALLY EXISTS, not a nonexistent cron.
- **Observed problem (evidence):** four purely BEHAVIORAL contracts, invisible to `tsc`:
  (i) **multi-loop FIFO** (`loop.ts:466 drainWakeQueue` + `:477` one-turn-at-a-time gate + `:496` return):
  with N live loops, EXACTLY ONE autopilot iteration at a time; the rest queue FIFO and drain in
  arrival order on `agent_end` (`:1521-1524`). If this breaks → N loops open turns in the SAME human turn
  and the destructive gate mis-fires / turns compete for the session. (ii) **fixed-mode NO-OP for
  `loop_schedule`** (`:1376`): in fixed mode the user owns the cadence → `loop_schedule` must be an
  informational no-op (do not touch timer/nextFireAt); if this breaks, the model reschedules a fixed cadence.
  (iii) **anti-zombie watchdog** (`:1106 watchdogSweep`, 25h backstop `:113`): a running loop past the
  backstop is force-stopped (`done`); a PAUSED loop of the same age is deliberately spared (`:1109`,
  a paused loop is not a zombie). (iv) **interval parser clamp** (`:278`, `[1s,24h]`) + rejection of
  non-matching tokens → dynamic (a `0s` must NOT become a busy-spin; a typo must not silently degrade
  fixed→dynamic). Zero prior e2e coverage for ALL of this.
- **Why this and not others:** highest value/(effort·risk). It was explicit pending item #2 and a named
  high-value candidate. Risk ~zero (new file, does not touch hot core, does not change runtime). Effort
  S/M: reuses the already proven self-bootstrapping pattern; key design point → do NOT wait for real timers:
  the FIRST wake of each loop fires SYNCHRONOUSLY inside `startLoop` (`fireWake` direct, not via setTimeout),
  and `agent_end` releases the gate and drains the next wake synchronously; the watchdog is tested by
  backdating `startedAt` through the `rehydrate` entry point (`session_start`). Never sleeps a setTimeout
  of ≥60s.
- **Rejected:** (i) proposing changes to core `dynamic-workflows.ts` → still hot, no concrete defect
  observed this pass; (ii) duplicating the `loop_schedule` clamp or destructive gates → ALREADY covered
  by safety-gates (would be theater); (iii) caps gate / pause-resume / loop rehydrate → good candidates
  but deferred to keep ONE bounded improvement (recorded as pending item #6); (iv) wiring into
  `npm test` → `package.json` outside allowlist (blocked, handoff candidate); (v) SKILL.md docs → minor/cosmetic
  gap.

**e2e design:** same self-bootstrapping pattern as safety-gates/goal-*. Builds the CURRENT `extensions/loop.ts`
to a tempdir (never stale), aliases `typebox`/SDK to local stubs (runs without `npm install`), drives the
real `/loop` command + `loop_schedule` tool + `agent_end`/`session_start` handlers against a mocked `pi`/`ctx`.
The `/loop` command returns `Promise<void>` (does not expose the `ActiveLoop`), so each loop is resolved
by its OBSERVABLE EFFECT: the `loopId` from the newest `loop-state` snapshot persisted via `appendEntry`.
Asserts the observable contract (which wake is delivered and in what order, persisted status,
clamped intervalMs), never copies of internals. 7 scenarios / **37 checks**: FIFO (A delivers 1,
B/C queue, drain B→C in order, empty queue does not re-deliver), no-delivery-while-busy (isIdle=false holds
until idle agent_end), refuse in print mode (no persist/no wake), fixed mode + `loop_schedule` no-op
(with positive control: dynamic DOES re-arm 1800), watchdog healthy-untouched, watchdog aged-zombie-killed +
paused-spared + healthy-untouched via rehydrate, interval parser/clamp (30s/5m/2h, 48h→24h, 0s/typo
→dynamic).

**Adversarial verification + anti-theater (fault-injection, 3 faults in temporary repo):**
- 37/37 checks PASS against the real source (EXIT 0). Clean relocated copy in temporary repo: green
  (control — confirms the harness follows the relocated source, not a stale one).
- **Fault #1 (break FIFO):** removed the one-turn-at-a-time gate (`:477`) and single-delivery `return`
  (`:496`) → `drainWakeQueue` delivers EVERYTHING at once. Suite RED: **35/37, 2 failures**, EXACTLY the 2
  FIFO checks (`delivered=3` instead of staged 1→2→3). Clean: green.
- **Fault #2 (break fixed no-op):** changed `if (loop.mode === "fixed")` (`:1376`) to `if (false)` → the
  model reschedules a fixed loop. Suite RED: **34/37, 3 failures**, EXACTLY the 3 fixed-no-op checks
  (`loop_schedule` re-armed with `delaySeconds:90`, mutated `nextFireAt`). The dynamic positive control
  stayed green → the suite distinguishes no-op from re-arm. Clean: green.
- **Fault #3 (disable watchdog):** inserted `return 0` at the start of `watchdogSweep` (`:1106`). Suite
  RED: **35/37, 2 failures**, EXACTLY the 2 zombie-kill checks (the aged zombie stayed alive,
  `status=undefined`); paused-spared and healthy-untouched stayed green (they do not become false positives
  because of the missing kill). Clean: green.
- Each fault tripped PRECISELY the checks that protect that behavior and nothing else; clean copy
  byte-identical to the source (`diff` empty) and green. ⇒ targeted regression detection, not theater.
- No regression in the previous suites: `safety-gates` 61/61, `goal-verifier` 30/30, `goal-rehydrate` 31/31.

**Verification commands (exit codes without pipe, all green):**
- `npm test` → **EXIT 0**.
- `npx esbuild extensions/loop.ts --platform=node --format=esm --packages=external` → **EXIT 0**.
- `node --check examples/e2e/{loop-behavior,safety-gates,goal-verifier,goal-rehydrate}.e2e.mjs` → **OK**.
- `node examples/e2e/loop-behavior.e2e.mjs` → **37/37, EXIT 0**.
- `node examples/e2e/safety-gates.e2e.mjs` → **61/61, EXIT 0** (no regression).
- `node examples/e2e/goal-verifier.e2e.mjs` → **30/30, EXIT 0** (no regression).
- `node examples/e2e/goal-rehydrate.e2e.mjs` → **31/31, EXIT 0** (no regression).

**Files touched (absolute paths):**
- NEW: `examples/e2e/loop-behavior.e2e.mjs`

- THIS log: `docs/research/continuous-improvement-log.md`

**Change type:** REAL (new file, behavior verified and fault-injected x3). Not a proposal.
**loop-until-dry counter:** 0 (this pass DID deliver a high-value improvement). Passes used: 4/8.
**Safeguards:** hot core `dynamic-workflows.ts` left untouched by me (mtime 08:00:42 from the other session —
still HOT; propose only). `goal.ts`/`loop.ts`/`plan.ts` with no diff (`git diff --stat` empty). My only
change: untracked `examples/e2e/loop-behavior.e2e.mjs`. No commit, no push.

**DECISION:** continue. Next highest-value pending item: pending #6 — e2e for caps gate / pause-resume /
rehydrate of `loop.ts` (the loop analog to the goal rehydration already covered).

### Close of Passes 3/8 and 4/8 — 2026-06-25 (finalization + re-verification)

Adversarial reviews R0 and R1 for both passes: **APPROVED, no blockers, no regressions**.
There were no fixes to apply (tree already green; both new e2e files already committable as untracked). Final
re-verification for this closing pass (direct exit codes, no pipe):
- `npm test` (tsc 4 extensions) → **EXIT 0** (green).
- `npx esbuild extensions/goal.ts …` → **EXIT 0**; `npx esbuild extensions/loop.ts …` → **EXIT 0** (bundle OK to scratchpad).
- `node --check` of `{goal-rehydrate,loop-behavior,safety-gates,goal-verifier}.e2e.mjs` → **OK** (all 4).
- `node examples/e2e/goal-rehydrate.e2e.mjs` → **31/31, EXIT 0**.
- `node examples/e2e/loop-behavior.e2e.mjs` → **37/37, EXIT 0**.
- No regression: `node examples/e2e/safety-gates.e2e.mjs` → **61/61, EXIT 0**; `node examples/e2e/goal-verifier.e2e.mjs` → **30/30, EXIT 0**.

**Safeguards (re-confirmed in this finalization):** hot core `extensions/dynamic-workflows.ts`
untouched by me (stable mtime 08:00:42, no diff — `git diff --stat extensions/` empty, EXIT 0; the other
session appears to have paused). `goal.ts`/`loop.ts`/`plan.ts` with no diff (only read by esbuild). `package.json`
untouched. My only changes: untracked `examples/e2e/goal-rehydrate.e2e.mjs` (Pass 3) +
`examples/e2e/loop-behavior.e2e.mjs` (Pass 4) + these log entries. NOT mine (untouched): `docs/README.md`
(M, external), `examples/e2e/dynamic-workflow-composition.e2e.mjs` (untracked, mtime 08:09, external),
`package-lock.json`, `.loop-e2e-build.mjs`, the `docs/planes/handoff-*.md`. No commit, no push, nothing irreversible.

**dry-counter:** 0 (both passes delivered a real high-value, fault-injected improvement). Passes used: 4/8.
**VERDICT:** continue. Next highest-value pending item: pending #6 — e2e for caps gate (maxIterations /
wall-clock / context-percent → status "done") + pause/resume (preserve remaining delay; resume dynamic vs
fixed) + rehydrate of `loop.ts` (stale→running a single catch-up tick, paused stays paused, last-wins
JSONL-vs-sidecar). It is the loop analog to the goal rehydration already covered.

---

## Pass 5/8 — 2026-06-25 — MATERIALIZE COMPOSITION (ctx.workflow)

**Baseline:** `npm test` (tsc for the 4 extensions) **green** at start (EXIT 0).

**Hot / external files detected (do not touch):** `extensions/dynamic-workflows.ts` (mtime 08:00:42,
stable — the other session appears paused, but the file is still core: propose only, do not edit).
**KEY FINDING:** the other session ALREADY materialized the prompt’s textual IMPROVEMENT A: there already are
`examples/workflows/lib/verify-claims.js` (07:58) and `examples/workflows/adaptive-composition-driver.js`
(07:57) — exactly the `lib/verify-claims` + driver requested by the prompt. Touching or duplicating them would be
collision/theater. Respected: I did NOT touch them (mtimes intact at close).

**CHOSEN improvement (honest re-framing):** since IMPROVEMENT A had already been done by the other session, I
materialized COMPOSITION with the SECOND building block that the prompt itself offered as an alternative:
`lib/rank-candidates` (different contract: SORTS instead of FILTERS). Three new files, all mine, none hot:
- `examples/workflows/lib/rank-candidates.js` — REUSABLE sub-workflow under `lib/`.
  Contract `{ candidates:[{id?,text}], rubric?, goal?, jurors?, keepTop? } -> { ranked(best-first), best,
  dropped, coverage }`. Independent jury (`ctx.agents(settle:true)` + `schema`), average clamped to
  [0,10], deterministic ordering with tie-break by id, juror cap to `ctx.limits.concurrency`, drop
  empty/non-text candidates. Consistent with the catalog’s `tournament` case ("Rank candidate designs").
- `examples/workflows/composition-rank-driver.js` — DRIVER: discovers candidates (generator agent) and delegates
  the reusable phase via `ctx.workflow("lib/rank-candidates", {...})`, then synthesizes the winner.
- `examples/e2e/composition-rank.e2e.mjs` — durable e2e that tests RESOLVABILITY + COHERENCE.

- **Why this and not another:** highest value/(effort·risk) WITHOUT collision or duplication. The prompt named
  `lib/verify-claims` OR `lib/rank-candidates`; the first had already been taken by the other session, so the
  second is the genuinely additive contribution. Risk ~zero (3 new untracked files, does not touch hot core
  or runtime). It also records a real gap in the core catalog: the `composition-driver` recipe
  (`dynamic-workflows.ts:658`) hardcodes ONLY `lib/verify-claims`; this second lib demonstrates that
  composition is a general pattern, not a one-off (candidate for a future PROPOSAL: add a
  `rank-candidates-lib`/second driver recipe to the catalog — not edited because it is core).
- **Resolution coherence (key to the prompt):** `ctx.workflow(name)` resolves from the runtime WORKFLOWS
  DIRECTORY (`.pi/workflows` or global), NOT from `examples/`. Both files have a header explaining the pattern
  and HOW to run it (copy `lib/` + driver to `.pi/workflows/` preserving the `lib/` path).
  The e2e TESTS this for real: it copies the REAL files from `examples/` to `.pi/workflows/` in a temporary
  project and runs the REAL extension.

**e2e design (same self-bootstrapping pattern already tested):** esbuilds the CURRENT `dynamic-workflows.ts` to
tempdir (never stale), aliases typebox/SDK/tui to stubs (runs without `npm install`), installs the REAL files
from `examples/workflows/` into `.pi/workflows/{,lib/}` of a temporary project, and handles the REAL
`dynamic_workflow` tool with `action:"run"`. The agent subprocess boundary is mocked via
`PI_DYNAMIC_WORKFLOWS_PI_COMMAND` (fake-pi that emits ONE JSON-mode `message_update` line; branches by prompt:
generator→candidate array, jury→deterministic `{score}`, synthesis→prose). **13 checks / 3 scenarios:** (1)
resolves+ranks (parent ok, best-first, best===ranked[0], worst last, numeric scores, coverage, lib artifact
lands in the SHARED runDir, workflow start/end events `lib/rank-candidates`); (2) drops blank candidate via
DIRECT call to the lib (another minimal parent → tests resolution without the generator); (3) **NEGATIVE
control:** if the `lib/` path is flattened (file at the root instead of under `lib/`),
`ctx.workflow("lib/rank-candidates")` does NOT resolve and the run FAILS with
`Workflow not found: lib/rank-candidates` → proves the header’s layout instruction is load-bearing, not decorative.

**Adversarial verification + anti-theater + OWN DEFECT FOUND AND FIXED:**
- **Real defect found by the e2e (not theater):** my first version returned `best: ranked[0]` (SAME reference
  as inside `ranked`). The runtime serializer (writeArtifact/`ctx.compact`) emits `"[Circular]"` for the second
  appearance of the shared object → `best` became unusable (`"[Circular]"`) in the artifact and in what the
  synthesis agent sees. The e2e exposed it (FAILs on `best===ranked[0]` and on the lib artifact). **Fix:**
  `best` is now a SHALLOW COPY (`{...finalRanked[0]}`) → no shared reference, no `[Circular]`. Re-verified green.
- **Fault-injection #1 (ordering):** I inverted the comparator (`a.score-b.score`, worst-first). Suite RED:
  **10/13, 3 failures**, EXACTLY the ordering checks (best-first, worst-last, lib best); resolution/
  composition/dropped/negative stayed green. Clean source: 13/13.
- **Fault-injection #2 (the [Circular] bug):** reintroduced `best: ranked[0]` (same ref). Suite RED:
  **11/13, 2 failures**, EXACTLY `best===ranked[0]` and the lib artifact. Clean source: 13/13.
- Each fault tripped PRECISELY the checks that protect that contract and nothing else ⇒ targeted detection, not theater.
- No regression in ALL previous suites (run, direct exit codes): composition-rank 13/13,
  dynamic-workflow-composition 16/16, safety-gates 61/61, goal-verifier 30/30, goal-rehydrate 31/31,
  loop-behavior 37/37 — all EXIT 0.

**Verification commands (all green):**
- `npm test` → **EXIT 0**.
- `node --check examples/workflows/lib/rank-candidates.js` + `…/composition-rank-driver.js` +

`examples/e2e/composition-rank.e2e.mjs` → **OK** (all 3).
- `node examples/e2e/composition-rank.e2e.mjs` → **13/13, EXIT 0**.
- Regression: dynamic-workflow-composition 16/16, safety-gates 61/61, goal-verifier 30/30, goal-rehydrate
  31/31, loop-behavior 37/37 — all EXIT 0.

**Files touched (absolute paths):**
- NEW: `examples/workflows/lib/rank-candidates.js`
- NEW: `examples/workflows/composition-rank-driver.js`
- NEW: `examples/e2e/composition-rank.e2e.mjs`
- THIS log.

**Type of change:** REAL (3 new files; own defect found+fixed; behavior verified and fault-injected x2). Not a proposal. **Deferred proposal (not edited):** add the second lib/driver to the core `dynamic-workflows.ts` recipes catalog (`composition-driver` currently only cites `lib/verify-claims`).
**dry-counter:** 0 (high-value pass). Passes used: 5/8.
**Safeguards:** hot core `dynamic-workflows.ts` left untouched by me (mtime 08:00:42 unchanged; extension `git diff
--stat` EMPTY). `lib/verify-claims.js`/`adaptive-composition-driver.js` from the other session left intact (mtimes 07:58/07:57). `package.json` untouched. No commit, no push, nothing irreversible.

---

## Pass 6/8 — 2026-06-25 — COMPOSITION: FAILURE + RECURSION contracts (IMPROVEMENT B)

**Baseline:** `npm test` (tsc for the 4 extensions) **green** at start (EXIT 0).

**Hot / external files detected (do not touch):** `extensions/dynamic-workflows.ts` STILL HOT —
the other session edited it ACTIVELY during this pass (mtime 10:40:25 → 10:41:08 → 10:43:13; size
278489B → 279649B). Only read to understand contracts; NOT edited by me (extension `git diff --stat` had no
`dynamic-workflows.ts` at close — the other session committed/reverted its WIP). `examples/e2e/dynamic-workflow-composition.e2e.mjs`
(external, other session, mtime 08:09) and the `examples/workflows/adaptive-{router,plan-and-execute,tree-of-thoughts,tournament}.js`
(external, 07:19-07:21) → NOT touched. My Pass 5 files (`lib/rank-candidates.js`, `composition-rank-driver.js`,
`composition-rank.e2e.mjs`) left intact.

**SELECTED improvement (IMPROVEMENT B, prompt option ii, REFRAMED to avoid collision):** new durable e2e
`examples/e2e/composition-failure-recursion.e2e.mjs` that pins TWO `ctx.workflow()` contracts that the existing
composition e2e (external) does NOT cover. **Key decision:** the prompt named "depth-1 recursion rejection"
and "changing child code re-executes on resume" as options — but BOTH are already covered by the external e2e
(`scenarioDepthLimit` covers the parent→child→grandchild NESTING guard; `scenarioChildCodeHashNamespacesResumeCache`
covers the resume cache). Editing that external file would collide with the other session. So I built a file
EXCLUSIVELY MINE that covers the real remaining gaps:
- **Contract 1 — DIRECT recursion (self-call):** a workflow that calls `ctx.workflow("<its own name>")`
  NEVER goes down a level, so the nesting guard (`composition depth limit is 1`) never fires. A SEPARATE path
  equality check in `runSubworkflow` (`dynamic-workflows.ts:5433`) rejects it with a DIFFERENT message
  (`refused recursive call ... may not call their parent`). Without that check = infinite recursion until
  stack/limits blow up. Zero previous coverage.
- **Contract 2 — sub-workflow FAILURE propagation + `phase:"error"` event:** when a child throws, (a) the
  failure propagates to the parent as a normal throw (recoverable with try/catch), and (b) the run records a
  `workflow phase:"error"` event with `ok:false` and the message (`dynamic-workflows.ts:5448-5453`). The external e2e only
  asserts the SUCCESS event (`phase:"end"`/`ok:true`). A regression that swallowed the child error (returning
  undefined instead of rethrowing) = parent silently continuing after a failed sub-step. Zero previous coverage.

- **Why this and not option (i):** rewriting router/plan/tot/tournament as composition would have touched
  EXTERNAL files (other session, 07:19-07:21) and, worse, `adaptive-tournament.js` does PAIRWISE elimination
  (different semantics from `lib/rank-candidates`, which is absolute scoring) → the rewrite would change semantics,
  not be "cleaner". Both prompt targets (the external composition e2e, the external inline examples)
  were taken by the other session → the genuinely additive, no-collision contribution is a new file of my own.

**Design finding (fixed in the e2e, not a core defect):** `action:"run"` does NOT return `{ok:false}`
on failure; it THROWS `formatRunSummary(result)` (`dynamic-workflows.ts:5957`). My first version read
`response.details.result.ok` and blew up with EXIT 2. Fix: `runExpectingFailure` helper that captures the throw and
parses the OBSERVABLE surface (`Artifacts: <runDir>` + `Error: <msg>`) that the agent/user sees — and from that
runDir reads `events.jsonl`. This is exactly what a real tool consumer faces.

**Adversarial verification + anti-theater (fault-injection in temporary repo, byte-identical control):**
- 16/16 against the real source (EXIT 0). Clean copy relocated into temporary repo: GREEN (`diff` empty vs
  source → the harness follows the relocated source, not a stale one).
- **Fault #1 (disable the self-recursion guard, `:5433` → `if (false)`):** suite RED **14/16, 2 failures**,
  EXACTLY the 2 self-recursion message checks. And it reveals the subtle point: with the path guard off, the
  self-call FALLS into the nesting guard and gets the WRONG message (`cannot call other sub-workflows`) →
  my "NOT mislabeled" check catches it. The 12 failure/recover checks stayed green.
- **Fault #2 (remove the `appendEvent phase:"error"` from the catch, rethrow intact):** suite RED **12/16, 4 failures**,
  EXACTLY the 4 error-event checks; run-fails, message, healthy-sibling-end/ok:true, and recover-run-ok
  stayed green → the suite distinguishes the ERROR event from the SUCCESS event, and the observable failure (run fails,
  parent recovers) from observability (event recorded).
- Each fault tripped PRECISELY its checks and nothing else ⇒ targeted detection, not theater.
- No regression: dynamic-workflow-composition 16/16, composition-rank 13/13, safety-gates 61/61, goal-verifier
  30/30, goal-rehydrate 31/31, loop-behavior 37/37 — all EXIT 0.

**Verification commands (all green, EXIT 0):**
- `npm test` → EXIT 0.
- `node --check examples/e2e/composition-failure-recursion.e2e.mjs` → OK.
- `node examples/e2e/composition-failure-recursion.e2e.mjs` → 16/16, EXIT 0.
- Regression: dynamic-workflow-composition 16/16, composition-rank 13/13, safety-gates 61/61, goal-verifier 30/30,
  goal-rehydrate 31/31, loop-behavior 37/37 — all EXIT 0.

**Files touched (absolute paths):**
- NEW: `examples/e2e/composition-failure-recursion.e2e.mjs`
- THIS log.

**Type of change:** REAL (new file; design finding found+fixed; behavior verified and
fault-injected x2). Not a proposal. **dry-counter:** 0 (high-value pass). Passes used: 6/8.
**Safeguards:** hot core `dynamic-workflows.ts` left untouched by me (the other session moved it to 10:43:13; at
close its WIP no longer appears in `git diff --stat` — committed/reverted by them; I ONLY read it).
`goal.ts`/`loop.ts`/`plan.ts` have no diff. `package.json` untouched. My only footprint: untracked
`examples/e2e/composition-failure-recursion.e2e.mjs` + this entry. No commit, no push, nothing irreversible.

---

## Goal ea88fc89 — Pass 1/8 — 2026-06-25

**Dynamic scout workflow:** `generated/goal-pass1-improvement-scout`
Run: `2026-06-25T13-34-47-683Z-generated-goal-pass1-improvement-scout-de44d739`
Artifacts: workflow run `2026-06-25T13-34-47-683Z-generated-goal-pass1-improvement-scout-de44d739` (legacy local run artifacts; `examples/` must not contain `.pi`).

**Inline baseline/scout:**
- `git status --short` showed external/not-mine work already present: `docs/README.md`, several `docs/planes/*`, `package-lock.json`, `examples/e2e/dynamic-workflow-composition.e2e.mjs`, `examples/workflows/composition-rank-driver.js`, `examples/workflows/lib/rank-candidates.js`, and later `examples/e2e/composition-failure-recursion.e2e.mjs` from another session.
- `npm test` → **EXIT 0** at start.
- `extensions/dynamic-workflows.ts` was treated as core/hot: not edited.

**Candidates found by the workflow (summary):**
- `e2e-hygiene` and `synthesis-judge`: add a single e2e runner `examples/e2e/run-all.mjs` without touching `package.json`.
- `workflow-examples` / `docs-drift`: consistency of ranking composition examples and docs; real candidate but several files were untracked/external.
- `loop-goal-plan`: future gap in non-interactive `/goal` rehydrate; requires touching `extensions/goal.ts`, deferred.

**Chosen improvement:** add `examples/e2e/run-all.mjs`, an explicit sequential runner for the durable e2e suite. Rationale: high value and low risk, new owned file, does not touch core or `package.json`, makes the existing behavioral verification observable in a single command.

**Implementation:**
- New: `examples/e2e/run-all.mjs`
- Explicit manifest of green suites: `composition-rank`, `dynamic-workflow-composition`, `goal-rehydrate`, `goal-verifier`, `loop-behavior`, `safety-gates`.
- `--list` prints suites and ignored drafts.
- Validation of unknown args.
- Per-suite timeout (`120_000ms`) to avoid indefinite hangs.
- Completeness check: any discovered `*.e2e.mjs` that is not in the manifest or in `ignoredDraftSuites` makes the runner fail. `composition-failure-recursion.e2e.mjs` was left explicitly in `ignoredDraftSuites` because it is an untracked draft from another session and currently fails; no other future files are silenced.

**Adversarial review:** `generated/goal-pass1-runner-adversarial-review`
Run: `2026-06-25T13-44-38-408Z-generated-goal-pass1-runner-adversarial-review-e0724bcc`
Artifacts: workflow run `2026-06-25T13-44-38-408Z-generated-goal-pass1-runner-adversarial-review-e0724bcc` (legacy local run artifacts; `examples/` must not contain `.pi`).

- `critic-safety`: **initial FAIL** for (1) omitting `composition-failure-recursion.e2e.mjs`, (2) not detecting unlisted suites, (3) not having a timeout. Fix applied: explicit ignored draft, unlisted-suite guard, timeout, and arg validation.
- `critic-correctness`: **initial FAIL** for the same omission/completeness issue. Fix applied: completeness guard + explicit draft allowlist.
- `critic-anti-theater`: did not block the central value (the runner makes the existing durable suite verifiable in one command); the anti-theater fix was to verify the full runner and not only `--list`.

**Verification (all green after fixes):**
- `node --check examples/e2e/run-all.mjs` → **EXIT 0**.
- `node examples/e2e/run-all.mjs --list` → lists 6 suites + `# ignored draft: examples/e2e/composition-failure-recursion.e2e.mjs`.
- `node examples/e2e/run-all.mjs --lisst; test $? -ne 0` → **test EXIT 0**, the runner rejects unknown args with an error.
- `npm test` → **EXIT 0**.
- `node examples/e2e/run-all.mjs` → **6/6 suites passed**, EXIT 0.

**Safeguards:** `extensions/dynamic-workflows.ts` was not edited; no push/publish/deploy; no `package.json`; no external files modified. The external draft `examples/e2e/composition-failure-recursion.e2e.mjs` was read/observed by the runner but not edited.

**Type of change:** REAL (new behavioral command that runs the full known durable suite, with timeout and manifest drift detection).
**dry-counter:** 0.
**Passes used by this goal:** 1/8.

**Recommended next pending item:** if the goal continues, do another scout with a dynamic workflow; likely candidates: (a) convert/stabilize `composition-failure-recursion.e2e.mjs` if its owner gets it ready, or (b) `/goal` non-interactive rehydrate gap in `extensions/goal.ts` with e2e, avoiding touching hot core.

---

## Pass 7/8 — 2026-06-25 — STATIC COMPOSITION: sub-workflow expansion in the GRAPH (`action:"graph"`)

**Baseline:** `npm test` (tsc for the 4 extensions) **EXIT 0** at start. The 7 previous e2e suites were green
(composition-rank 13/13, dynamic-workflow-composition 16/16, composition-failure-recursion 16/16,
safety-gates 61/61, goal-verifier 30/30, goal-rehydrate 31/31, loop-behavior 37/37). NOTE: the log from
Pass 1 of goal ea88fc89 marked `composition-failure-recursion.e2e.mjs` as a "failing draft" in
`ignoredDraftSuites` of `run-all.mjs`; TODAY it passes 16/16 (its owner stabilized it). I did not reclassify it (external).

**Hot / external files detected (do not touch):** `extensions/dynamic-workflows.ts` mtime 10:50:24,
stable throughout the pass (the other session committed `ccc51ca`/`907f0c2` and paused). It is CORE/hot:
only READ to understand contracts; `git diff --stat extensions/` **EMPTY** at close. External files
(not touched): `run-all.mjs` (from the other session, untracked, 10:46 — see below for the only minimal
and justified exception), `composition-failure-recursion.e2e.mjs` (external), `examples/workflows/adaptive-*`,
`docs/**`, `package*.json`. My Pass 5 files untouched.

**Finding (real gap, high value, no collision):** the commits newly landed by the other session —
`ccc51ca` "expand subworkflows in workflow graphs" + `907f0c2` "ignore comments when graphing workflow
calls" — introduced an **ENTIRELY NEW and UNCOVERED by e2e** composition surface:
`buildWorkflowGraphModelWithSubworkflows` (`dynamic-workflows.ts:2527`), invoked by `action:"graph"`
(`:5955-5959`) via `makeWorkflowGraphForContext` (`:2983`). It is ORTHOGONAL to everything covered: passes
5/6 and the external `dynamic-workflow-composition` e2e exercise ONLY **runtime** composition
(`action:"run"/"resume"` → `runSubworkflow`). NOBODY exercised **STATIC** composition (the graph that
expands `ctx.workflow("name")` one level by reading the child file in preview). A silent regression here
is NOT caught by `tsc` (it is string parsing + file resolution + rendering) nor by any current e2e.
Verified the gap with `grep` over `examples/e2e/`: no file touched `action:"graph"` with expansion.

**CHOSEN improvement:** new durable e2e, exclusively mine, no collision:
`examples/e2e/composition-graph-expansion.e2e.mjs`. It is the STATIC analogue of
`dynamic-workflow-composition.e2e.mjs`. **Six OBSERVABLE contracts** (all surfaced in
`details.graph` / `content` text of `action:"graph"`, exactly what the agent/user sees):
1. **Happy literal expansion:** `ctx.workflow("lib/rank-candidates")` with a LITERAL name resolves the
   child file, parses it, and the graph contains `expands: lib/rank-candidates (<n> steps)` + the subgraph
   lines (`renderWorkflowGraphSubworkflowSummaryLines`), with the child’s own steps
   (`ctx.agents`/`ctx.writeArtifact`) inlined; emits the note "literal names are expanded one level";
   no `subgraph unavailable` for a resolvable child.
2. **Dynamic name:** `ctx.workflow(variable)` is NOT resolved → "dynamic sub-workflow name; cannot
   resolve statically"; it is still detected as a step but does NOT assert `expands:`.
3. **Depth limit:** the child resolves, but ITS own `ctx.workflow` (grandchild) is NOT expanded
   (`depth >= 1` `:2547`) → "nested sub-workflows are not expanded; runtime composition depth limit is 1";
   the grandchild body is NOT inlined.
4. **Recursion guard:** a workflow that calls ITSELF (`ctx.workflow("<its own name>")`) →
   at depth 0 the resolved path is already in `seen` (`:2554`) → "recursive sub-workflow skipped: <name>".
   Explicit check that it is NOT labeled as depth-limit (the `seen` guard wins in the depth-0 self-call;
   a deeper cycle hits the depth-limit first).
5. **Unresolvable literal:** `ctx.workflow("lib/no-such-workflow")` → `resolveWorkflow` throws, captured as
   `subworkflowError` "Workflow not found: lib/no-such-workflow" (`:2560-2562`); does not assert `expands:`.
6. **Ignore comments (commit `907f0c2`):** a `ctx.workflow(...)` inside a `//` or `/* */` comment is NOT
   detected as a step (`isJavaScriptCodePosition` `:2197`); **symmetric positive control:** an
   IDENTICAL workflow with the call UNCOMMENTED DOES expand → proves the negative is caused by the comment.

- **Design finding during development (fixed in the e2e, NOT a core defect):** my first version of the
  recursion scenario created a TWO-level cycle (parent→child→parent). That does NOT trigger the `seen`
  guard: at depth 1 the `depth >= 1` check (`:2547`) cuts off BEFORE reaching the `seen` check
  (`:2554`), so the cycle gets the depth-limit message, not the recursion message. I corrected the scenario
  to a **depth-0 self-call** (the only path that reaches the `seen` guard). The e2e now pins BOTH
  messages separately (recursion vs depth-limit) and verifies they are not confused.
- **Why this and not another:** better value/(effort·risk) WITHOUT collision. The surface is new and orphaned
  from coverage; risk is ~zero (one new e2e file + one additive line in `run-all.mjs`); reuses the already
  proven self-bootstrapping harness. Rejected: (i) touching hot core `dynamic-workflows.ts`
  (only propose); (ii) editing the external composition e2e (collision).

**E2E design:** same proven self-bootstrapping pattern. It builds CURRENT `dynamic-workflows.ts` to a
tempdir (never stale), aliases typebox/SDK/ai/tui to stubs (runs without `npm install`), installs MINIMAL
source workflows in `.pi/workflows/{,lib/}` of a temporary project (the graph only PARSES the child, does
not execute it → no fake-pi needed), and handles the REAL `dynamic_workflow` tool with `action:"graph"`. Asserts

the OBSERVABLE graph text (not copies of internals). Extra cross-cutting check: `details.graph` ===
`content` text (regression on the response shape). **31 checks / 6 scenarios.**

**Adversarial verification + anti-theater (fault injection in temporary repo, byte-identical control):**
- 31/31 against the real source (EXIT 0). Clean copy relocated into a temporary repo: GREEN (`diff` empty
  vs source → the harness follows the relocated source, not a stale one), before AND after each fault.
- **Fault #1 (disable ignore-comments, `isJavaScriptCodePosition` → `return true`):** suite RED
  **29/31, 2 failures**, EXACTLY the 2 comment checks (the commented `ctx.workflow` was detected/
  expanded). Everything else green.
- **Fault #2 (swallow the resolution error: empty the `catch` that sets `subworkflowError`):** suite RED
  **30/31, 1 failure**, EXACTLY the "surfaces Workflow not found" check. The dynamic-name check
  stayed green because that path sets `subworkflowError` DIRECTLY (`:2544`), not via the catch → the suite
  distinguishes the two sources of `subworkflowError`.
- **Fault #3 (break the depth limit, `depth >= 1` → `depth >= 99`):** suite RED **29/31, 2 failures**,
  EXACTLY the 2 depth checks (the grandchild was expanded/inlined). Everything else green.
- Each fault triggered PRECISELY its checks and nothing else ⇒ targeted detection, not theater.
- No regression in ALL previous suites (runs, direct exit codes): composition-graph-expansion
  31/31, dynamic-workflow-composition 16/16, composition-rank 13/13, composition-failure-recursion 16/16,
  safety-gates 61/61, goal-verifier 30/30, goal-rehydrate 31/31, loop-behavior 37/37 — all EXIT 0.

**Verification commands (all green, EXIT 0):**
- `npm test` → EXIT 0.
- `node --check examples/e2e/composition-graph-expansion.e2e.mjs` → OK.
- `node examples/e2e/composition-graph-expansion.e2e.mjs` → 31/31, EXIT 0.

**Files touched (absolute paths):**
- NEW: `examples/e2e/composition-graph-expansion.e2e.mjs`
- THIS log.

**Type of change:** REAL (new file; design finding found+fixed; behavior verified and
fault-injected x3). Not a proposal.
**dry-counter:** 0 (high-value pass). Passes used: 7/8.

---

## Pass 8/8 — 2026-06-25 — INTEGRATE the new suite into `run-all.mjs` (without breaking its drift guard)

**Baseline:** `npm test` EXIT 0; the 8 e2e suites green (incl. the new composition-graph-expansion 31/31).

**Observed problem (regression that I introduced in Pass 7, direct evidence):** `run-all.mjs` has an explicit
**drift guard** (`:57-66`): it discovers all `*.e2e.mjs` in the directory and FAILS (exit 1) if
any are in neither `suites` nor `ignoredDraftSuites`. After adding `composition-graph-expansion.e2e.mjs`
in Pass 7, `node examples/e2e/run-all.mjs --list` started failing:
`Unlisted e2e suite(s) found ... composition-graph-expansion.e2e.mjs` (verified, exit 1). Leaving this broken
is worse than having changed nothing: the single runner stops running. This is a real regression, not cosmetic.

**CHOSEN improvement (minimal blocking fix):** register the new GREEN suite in the `suites` array in
`run-all.mjs` (one additive line, in alphabetical order, without touching existing entries). It goes in `suites`
(not `ignoredDraftSuites`) because it is green and fault-injected. I did **NOT** reclassify
`composition-failure-recursion.e2e.mjs` (it remains in `ignoredDraftSuites`): it is someone else's draft, not mine
to move even if it passes today, and leaving it there is inert (the guard only requires it to be listed, not its state).

- **Ownership note (honest):** `run-all.mjs` is untracked and was created by the other session (Goal ea88fc89 —
  Pass 1, mtime 10:46:34, stable). Normally I would not touch someone else's file. The exception is justified
  because (a) the breakage was caused by ME in Pass 7, (b) the file's own contract REQUIRES registering every
  new suite ("Add a suite here once it is expected to be green"), and (c) the change is a single ADDITIVE line
  that does not alter any existing entry or logic. It is the minimal action that restores the invariant.
  `run-all.mjs` mtime 10:46:34, no concurrent changes from the other session during the pass.

**Verification (all green, EXIT 0):**
- `node --check examples/e2e/run-all.mjs` → OK.
- `node examples/e2e/run-all.mjs --list` → lists 7 suites + `# ignored draft: composition-failure-recursion.e2e.mjs`, EXIT 0 (drift guard satisfied).
- `node examples/e2e/run-all.mjs` → **7/7 suites passed**, EXIT 0.
- `npm test` → EXIT 0.

**Files touched (absolute paths):**
- EDITED (single additive line, justified above): `examples/e2e/run-all.mjs`
- THIS log.

**Type of change:** REAL (blocking fix for the regression introduced in Pass 7; integrates the new suite into the
durable runner). Not a proposal.
**dry-counter:** 0. Passes used: 8/8 (budget exhausted).
**Safeguards:** hot core `dynamic-workflows.ts` untouched by me (`git diff --stat extensions/` EMPTY,
mtime 10:50:24 stable). `goal.ts`/`loop.ts`/`plan.ts` no diff. `package.json` untouched. My changes:
untracked `examples/e2e/composition-graph-expansion.e2e.mjs` + 1 line in the other session's untracked
`run-all.mjs` + these log entries. No commit, no push, nothing irreversible.

**VERDICT:** done (8/8 budget exhausted; composition was MATERIALIZED in runtime —passes 5/6—
and in static/graph —passes 7/8—, with the suite integrated into the durable runner). Pending for future loops
(non-blocking): (a) PROPOSAL to core: add a second lib/driver to the recipe catalog
(`composition-driver` currently only cites `lib/verify-claims`); (b) `/goal` non-interactive rehydrate gap in
`extensions/goal.ts`; (c) if the owner of `composition-failure-recursion.e2e.mjs` considers it stable,
move it from `ignoredDraftSuites` to `suites` in `run-all.mjs`.

---

## Pass 7/8 (FINAL) — 2026-06-25 — IMPROVEMENT A: APPROVAL HANDSHAKE + LIFECYCLE of `plan.ts`

**Baseline:** `npm test` (tsc 4 extensions) **EXIT 0**. `node examples/e2e/run-all.mjs` → **7/7 suites passed**,
EXIT 0 (composition-graph-expansion 31, composition-rank 13, dynamic-workflow-composition 16, goal-rehydrate 31,
goal-verifier 30, loop-behavior 37, safety-gates 61).

**Hot / external files detected (do not touch):** `extensions/dynamic-workflows.ts` (mtime 10:50:24,
stable — CORE/hot, only read conceptually, NOT edited) and `extensions/compaction-progress.ts` (mtime
11:13:57, NEW file from the other session — not touched). `run-all.mjs` (untracked, external, mtime 10:57:37 stable
— see minimal justified exception below). `plan.ts` mtime 06:48:10, no diff, **NOT hot** → editable per
safeguards, but I did NOT edit it (the improvement is a new e2e, it does not touch the extension runtime).

**Real gap (evidence):** `safety-gates.e2e.mjs` already covers ONLY the **read-only gate** of `plan.ts` — the
pure predicate `blockedReason`/`isMutatingBash` (which tool is blocked/allowed while the mode is armed) +
the refuse in print/json. It does NOT cover the OTHER half —what the module's own doc calls "the new parts"— the
**APPROVAL HANDSHAKE and LIFECYCLE**, which is a pure runtime state machine (invisible to `tsc`) and the
MOST consequential behavior of the extension. Verified the gap with `grep` over `examples/e2e/`: no
file handled `submit_plan`/`ctx.ui.confirm`/the approval cycle. The dangerous direction: a reject/exit
that accidentally LIFTS the gate, or an approve that does NOT lift it, or a terminal state that RE-arms the gate on reload
— exactly the guarantee this feature exists to provide (do not mutate without the user's EXPLICIT approval).

**CHOSEN improvement (IMPROVEMENT A):** new durable e2e, mine only, no collision:
`examples/e2e/plan-approval.e2e.mjs`. It drives the `/plan` command, the `submit_plan` tool, and the REAL
`tool_call`/`session_start` handlers against mocked `pi`/`ctx` (same proven self-bootstrapping pattern:
esbuild of CURRENT `extensions/plan.ts` to tempdir, local stubs for typebox/SDK, no `npm install`). It asserts the
OBSERVABLE CONTRACT (gate armed-or-not via a real `tool_call` of `write`, persisted `plan-state`, re-injected
messages, tool `details`), never copies of internals. **52 checks / 5 scenarios:**
1. **APPROVE** (`confirm=PASS`): lifts the gate (a previously blocked `write` now PASSES), persists
   `status=approved`/`active=false`, re-injects "Plan approved. Implement now:\n\n<plan>" with the EXACT text,
   `details.status=approved`, `submissions=1`/`rejections=0`.
2. **REJECT** (`confirm=REJECT`): the gate STAYS armed (same `write` remains BLOCKED), `rejections=1`,
   `status=planning`/`active=true`, does **NOT** re-inject implement, `details.status=rejected` + text asking to
   revise+resubmit; then a follow-up APPROVE DOES close → revise→resubmit→approve cycle (it carries the
   approved v2 plan, NOT the rejected v1; `submissions=2`/`rejections=1` retained).

3. **`/plan exit`** and **`/plan cancel`**: abort — lift the gate, `status=exited`, and **DO NOT** re-inject
   implement (no implicit implementation).
4. **`submit_plan` with no active plan**: `isError`, no crash, no persistence, no message.
5. **rehydrate (`session_start`):** an ACTIVE plan RE-arms the gate on reload (write blocked again) without
   re-injecting the planning prompt; a TERMINAL one (approved/exited) stays INERT; last-wins by planId in both
   directions (late-terminal wins / late-active wins); **fork = no-op** (does not migrate); junk/foreign/malformed
   ignored without crashing, with a valid active one still re-arming.

**Honest finding during development:** the line `if (!state.active) continue;` (`plan.ts:444`) is a cheap
SKIP, NOT the load-bearing safety check — `planModeActive()` re-checks `plan.active`, so removing ONLY line 444 is
OBSERVABLY INERT (a restored terminal keeps `active:false` → does not arm the gate). My terminal checks pin the
OBSERVABLE contract (terminal ⇒ gate not armed), which holds; the load-bearing invariant is "the restored plan
preserves its persisted `active` flag". Same pattern as the finding from Pass 3 (goal-rehydrate). Documented, not
hidden — and Fault #3b (below) proves my checks are NOT theater.

**Adversarial verification + anti-theater (fault injection in temp repo, byte-identical control):**
- 52/52 against the real source (EXIT 0). Clean copy relocated into temp repo: GREEN (`diff` empty vs
  source → the harness follows the relocated source, not a stale one), before AND after each fault.
- **Fault #1 (APPROVE does not lift the gate, `plan.active=false` neutralized at `:549`):** suite RED **48/52,
  4 failures**, EXACTLY the 4 "approve lifts the gate" checks (write-allowed + persisted-active=false, on
  direct approve AND reject→approve). Nothing else red.
- **Fault #2 (REJECT lifts the gate — the DANGEROUS direction — `plan.active=false` injected before the
  rejection counter, `:563`):** suite RED **45/52, 7 failures**, tripping "reject: write STILL BLOCKED" + "reject:
  persisted active=true" + the cascade from the second submit (the prematurely deactivated plan breaks `currentPlan()`
  → `submit_plan` v2 falls into the "no active plan" path). The critical guarantee (reject MUST NOT mutate the
  workspace) is caught.
- **Fault #3 (remove ONLY the terminal guard `:444`):** suite GREEN 52/52 → honest finding above (over-recovery
  OBSERVABLY INERT because `planModeActive()` re-checks `active`).
- **Fault #3b (the GENUINE over-recovery defect: remove guard `:444` AND force `active:true` in restore
  `:446`):** suite RED **49/52, 3 failures**, EXACTLY the 3 terminal-stays-INERT checks (terminal-approved,
  terminal-exited, last-wins-terminal); ACTIVE recovery checks (5a/5e/5g) and fork (5f) stayed green → the suite
  distinguishes the safety direction and is NOT theater on the terminal path.
- Each fault tripped PRECISELY its checks and nothing else ⇒ targeted detection. Source restored byte-identical
  after each fault, green control EXIT 0.
- No regression: the 7 previous suites + the new one → **8/8 suites passed** via `run-all.mjs`, EXIT 0.

**Regression introduced and fixed in the SAME pass (`run-all.mjs` drift-guard):** adding the new suite
made the `run-all.mjs` drift-guard fail (`:62-67`, exit 1: "Unlisted e2e suite(s) found ... plan-approval.e2e.mjs").
Minimal fix: register the GREEN suite in the `suites` array (a single ADDITIVE line, alphabetical order, between
`loop-behavior` and `safety-gates`). It goes in `suites` (not `ignoredDraftSuites`) because it is green and fault-injected.
**Justified exception** for touching `run-all.mjs` (untracked, foreign): (a) I caused the breakage by adding the suite,
(b) the file’s own contract REQUIRES registering every green suite ("Add a suite here once it is expected to be
green"), (c) it is an additive line that does not alter any entry or the logic. Same pattern as Pass 8 of the
previous goal. `run-all.mjs` mtime 10:57:37 stable, no concurrent edit during the pass.

**Verification commands (direct exit codes, all green):**
- `npm test` → **EXIT 0**.
- `node --check examples/e2e/{plan-approval,run-all}.mjs` → **OK** (both).
- `node examples/e2e/plan-approval.e2e.mjs` → **52/52, EXIT 0**.
- `node examples/e2e/run-all.mjs --list` → 8 suites + `# ignored draft: composition-failure-recursion.e2e.mjs`, **EXIT 0** (drift-guard satisfied).
- `node examples/e2e/run-all.mjs` → **8/8 suites passed, EXIT 0** (no regression).

**Files touched (absolute paths):**
- NEW: `examples/e2e/plan-approval.e2e.mjs`
- EDITED (1 additive line, justified above): `examples/e2e/run-all.mjs`
- THIS log.

**Change type:** REAL (new file; honest finding documented; behavior verified and fault-injected
x4 incl. negative control #3b). Not a proposal.
**dry-counter:** 0 (high-value pass). **Safeguards:** `git diff --stat extensions/` **EMPTY** (`plan.ts`
mtime 06:48:10 intact; `dynamic-workflows.ts` 10:50:24 and `compaction-progress.ts` 11:13:57 foreign/intact).
`package.json` untouched. My changes: untracked `examples/e2e/plan-approval.e2e.mjs` + 1 line in the untracked
foreign `run-all.mjs` + this entry. No commit, no push, nothing irreversible.

---

## Pass 8/8 (FINAL) — 2026-06-25 — IMPROVEMENT B: CAPS + PAUSE/RESUME + durable REHYDRATE for `loop.ts`

**Baseline:** `npm test` (tsc 4 extensions) **EXIT 0**. `node examples/e2e/run-all.mjs` → **8/8 suites passed**,
EXIT 0 (composition-graph-expansion 31, composition-rank 13, dynamic-workflow-composition 16, goal-rehydrate 31,
goal-verifier 30, loop-behavior 37, plan-approval 52, safety-gates 61).

**Hot / foreign files detected (do not touch):** `extensions/dynamic-workflows.ts` (mtime 10:50:24, stable —
CORE/hot, NOT edited) and `extensions/compaction-progress.ts` (11:13:57, NEW foreign from the other session — not
touched). `run-all.mjs` (untracked, foreign, stable mtime — see minimal justified exception below). `loop.ts`
mtime **06:32:56, no diff, NOT hot** → editable per safeguards, but I did NOT edit it (the improvement is a new e2e;
it does not touch the extension runtime). `git diff --stat extensions/` **EMPTY** at close.

**Real gap (evidence, different from A and from loop-behavior):** `loop-behavior.e2e.mjs` covers ONLY the
scheduling engine (multi-loop FIFO / fixed-mode `loop_schedule` no-op / anti-zombie watchdog / interval
parse+clamp). It does NOT cover the **DURABILITY surface** of `loop.ts`, which is pure runtime behavior
(invisible to `tsc`) and the most consequential for an autonomous loop: (1) the **CAPS gate** (`capExceeded`/`stopForCap`,
checked in `fireWake` + `agent_end` + `rehydrate`) that cuts to `"done"` when reaching `maxIterations`,
`maxWallClockMs` (absolute deadline), or `contextPercentCap`; (2) **PAUSE/RESUME** (`pauseLoop`/`resumeLoop`,
`/loop pause|resume`) — pause clears the timer, preserves state, drops the queued wake, and does NOT re-inject; resume
re-arms (dynamic with the remainder, fixed by its period); (3) **loop REHYDRATE** after reload (`rehydrate` in
`session_start`) — revives running/stale (single catch-up, no double-fire), keeps paused, ignores terminals,
last-wins by updatedAt, and **WITHDRAWS an AUTONOMOUS loop if the project is no longer trusted** (P2 re-entry gate).
Verified the gap with `grep` over `examples/e2e/`: no file (except the mock setup that returns `undefined`)
handles caps cut-to-done, pause/resume, or loop rehydrate. Dangerous direction: swallowed cap = loop runs forever;
paused loop that re-injects; autonomous loop that keeps firing unattended after trust is revoked.

**Chosen improvement (IMPROVEMENT B):** new durable e2e, exclusively mine, no collision:
`examples/e2e/loop-caps-resume.e2e.mjs`. Handles the `/loop` command (+ `pause`/`resume`/`stop`), the
`loop_schedule` tool, and REAL `agent_end`/`session_start` handlers against mocked `pi`/`ctx` (same proven
self-bootstrapping pattern: esbuild of CURRENT `extensions/loop.ts` to tempdir, local typebox/SDK stubs, no
`npm install`). Asserts the OBSERVABLE CONTRACT (persisted `loop-state` status/reason, re-injected wakes, whether a
timer was armed), never copies of internals. **48 checks / 9 scenarios:**
1. **maxIterations** cuts to `done` through its REAL gate (`fireWake`, not `agent_end` — see finding) via
   rehydrate catch-up; iteration does NOT advance, no wake.
2. **maxWallClockMs**: a loop past its deadline stops as `done` on rehydrate (wall-clock reason, NOT mislabeled as
   maxIterations), no wake.
3. **contextPercentCap**: below cap (10%<90%) stays running; above cap (95%≥90%) stops as `done` in
   `agent_end`; **negative control:** `percent:null` is NOT a cap hit (best-effort).

4. **PAUSE/RESUME**: pause persists `paused`, does not re-inject, preserves iteration, and the `agent_end` safety net does NOT
   re-arm a paused loop; resume returns to `running` with a future `nextFireAt` and reason "resumed"; resuming a running loop is
   a no-op (no spurious `paused` snapshot).
5. **pause drops QUEUED wake**: B queues behind A; when pausing B and closing A's turn, B (paused) does NOT fire.
6. **rehydrate revives without double-fire**: stale→running, a single catch-up (it 2→3, 1 wake); second `session_start`
   does NOT fire again (already alive).
7. **rehydrate paused/terminal/last-wins**: paused stays paused; `done`/`stopped` ignored (no persist);
   last-wins by updatedAt in BOTH directions (late-terminal wins → no revive; late-running wins → revive+catch-up).
8. **autonomous trust gate**: autonomous in UNtrusted project → retired `stopped` (reason mentions trust), no
   wake; **positive control:** autonomous in trusted project → revived running + catch-up (proves the retire is caused by
   trust revocation, not that autonomous loops are unrecoverable).
9. **rehydrate respects caps**: a DUE loop but over-budget stops as `done` instead of re-arming; no wake; iteration
   does not advance (the "due AND over-budget" collision — the cap wins).

**Honest findings during development (MY defects found by the suite, NOT core defects):**
- **#1:** my first version of the maxIterations scenario pulsed `agent_end` expecting the stop. FALSE: `agent_end`
  only runs `capExceeded` (wall-clock/context) + re-arms; the `maxIterations` gate lives in `fireWake`/`drainWakeQueue`.
  Fixed to exercise the REAL gate via the rehydrate catch-up (`setTimeout(fireWake,0)`, awaited with a `tick()`).
  The suite forced me to exercise the correct path.
- **#2 (scope, documented):** Fault #2 (removing ONLY `dropQueuedWakes` from `pauseLoop`) stayed GREEN → that drop is
  cheap early cleanup, NOT the load-bearing check: `drainWakeQueue` re-checks `loop.status !== "running"` on
  delivery (`:483`), so a queued paused loop is still dropped at delivery. The `pausequeue` check pins the OBSERVABLE
  contract (paused never fires), which is upheld by that redundant guard. Same honest pattern as pass 3/7.
  Fault #2b (below) proves the check is NOT theater.

**Adversarial verification + anti-theater (fault injection in temp repo, byte-identical control):**
- 48/48 against the real source (EXIT 0). Clean copy relocated into temp repo: GREEN (`diff -q` empty vs source,
  EXIT 0 — the harness follows the relocated source, not a stale one; restored byte-identical between faults).
- **Fault #1 (neutralize `capExceeded` → always `undefined`):** suite RED **41/48, 7 failures**, EXACTLY the
  wall-clock checks (2) + context-over (2) + rehydrate-cap (3). maxIterations (separate gate) and the context-null negative
  control stayed GREEN → the suite distinguishes budget caps from the iteration cap.
- **Fault #2b (the DANGEROUS direction: remove the pause drop AND the status guard in `drainWakeQueue:483` → a
  queued paused loop DOES fire):** suite RED **47/48, 1 failure**, EXACTLY `pausequeue: paused B does NOT fire`
  (`delivered=2`). Nothing else red → the pause/queue contract is load-bearing.
- **Fault #3 (disable the autonomous re-entry gate `state.autonomous && !isProjectTrusted()` → `if(false)`):**
  suite RED **46/48, 2 failures**, EXACTLY the 2 untrusted-retire checks (`status=undefined`: the autonomous loop was
  REVIVED instead of retired — the security regression). The trusted-revive positive control stayed GREEN.
- **Fault #4 (disable the no-double-fire guard `activeLoops.has(loopId)` → `if(false)`):** suite RED **47/48,
  1 failure**, EXACTLY `rehydrate: second session_start does NOT double-fire` (`delivered=2`).
- Each fault tripped PRECISELY its checks and nothing else ⇒ targeted detection, not theater. Source restored
  byte-identical after each fault (GREEN control EXIT 0).
- No regression: the 8 previous suites + the new one → **9/9 suites passed** via `run-all.mjs`, EXIT 0.

**Regression introduced and fixed in the SAME pass (`run-all.mjs` drift guard):** adding the new suite made
the drift guard fail (`node examples/e2e/run-all.mjs --list` → exit 1, "Unlisted e2e suite(s)"). Minimal fix: register
the GREEN suite in the `suites` array (1 ADDITIVE line, alphabetical order, between `loop-behavior` and `plan-approval`). It goes in
`suites` (not `ignoredDraftSuites`) because it is green and fault-injected. **Justified exception** for touching `run-all.mjs`
(untracked, external): (a) I CAUSED the breakage by adding the suite, (b) the file's own contract REQUIRES registering
every green suite, (c) it is an additive line that does not alter any entry or logic. Identical pattern to Pass 8
of the previous goal and IMPROVEMENT A (pass 7).

**Verification commands (direct exit codes, all green):**
- `npm test` → **EXIT 0**.
- `node --check examples/e2e/{loop-caps-resume,run-all}.mjs` → **OK** (both).
- `node examples/e2e/loop-caps-resume.e2e.mjs` → **48/48, EXIT 0**.
- `node examples/e2e/run-all.mjs --list` → 9 suites + `# ignored draft: composition-failure-recursion.e2e.mjs`, **EXIT 0** (drift guard satisfied).
- `node examples/e2e/run-all.mjs` → **9/9 suites passed, EXIT 0** (no regression).

**Files touched (absolute paths):**
- NEW: `examples/e2e/loop-caps-resume.e2e.mjs`
- EDITED (1 additive line, justified above): `examples/e2e/run-all.mjs`
- THIS log.

**Change type:** REAL (new file; 2 honest findings documented; behavior verified and fault-injected
x4 incl. the #2b/#3 negative control for the dangerous direction). Not a proposal.
**dry-counter:** 0 (high-value pass). **Safeguards:** `git diff --stat extensions/` **EMPTY** (`loop.ts` mtime
06:32:56 intact; `dynamic-workflows.ts` 10:50:24 and `compaction-progress.ts` 11:13:57 external/intact). `package.json`
untouched. My changes: untracked `examples/e2e/loop-caps-resume.e2e.mjs` + 1 line in the external untracked `run-all.mjs`
+ this entry. No commit, no push, nothing irreversible.

---

## Loop CLOSE — 2026-06-25 (finalizing passes 7-8, cap of 8 reached)

**BLOCKING fix applied at close (flakiness regression, ours only):** when running the FULL suite via
`run-all.mjs` (the 9 sequential suites in child processes), `goal-rehydrate.e2e.mjs` (ours, Pass 3) failed
**INTERMITTENTLY** 28/31 — always the 3 checks in the `verifying` scenario (due catch-up): `states=0`,
`firedStatus=<none>`, `messages=0`. Diagnosis (not a source regression — `git diff --stat extensions/` EMPTY,
`goal.ts` committed with no diff; in isolation the suite gave reproducible 31/31): **timing race in the test helper
`flush`**, which only yielded to `setImmediate` (check phase). The `rehydrate` catch-up is armed with
`setTimeout(fireGoal, 0)` (`goal.ts:914`, `remaining=0` for a due `nextFireAt`) → TIMERS phase; under load (3
previous child processes from the runner), the `setImmediate` spin can starve the timers phase for more than 50 turns and the
predicate never becomes true. **Fix:** `flush` now yields to BOTH phases per iteration (`await setTimeout(r,0)` +
`await setImmediate(r)`) and increases `tries` 50→100. This is exactly the pattern that `loop-caps-resume.e2e.mjs` (Pass 8)
already used in its `tick()` (`setTimeout(resolve,0)`) — which is why that suite was never flaky. Test-helper-only change,
in our file; does not touch runtime or extension contracts.
- **Green→red→green verification:** RED reproduced (1st runner execution: `8/9 suites passed`, goal-rehydrate
  FAIL 28/31, the 3 `verifying` checks). After the fix: isolated goal-rehydrate **31/31 EXIT 0**; full runner executed
  **5 consecutive times → 9/9 suites passed, EXIT 0 every time** (flakiness eliminated). Confirmed no other suite
  shares the defect: `goal-verifier.e2e.mjs` uses the same `setImmediate`-only `flush` BUT does not depend on a due timer
  (its chain resolves through `pi.exec`/microtasks) → stable 5/5 in isolation; `loop-caps-resume` already used the
  correct pattern.

**FINAL close verification (direct exit codes, no pipe):**
- `npm test` (tsc for the 5 extensions, incl. external `compaction-progress.ts`) → **EXIT 0**.
- `node --check` for `{goal-rehydrate,plan-approval,loop-caps-resume,composition-graph-expansion,run-all}` → **OK** (all 5).
- `node examples/e2e/run-all.mjs` → **9/9 suites passed, EXIT 0** (composition-graph-expansion 31, composition-rank 13,
  dynamic-workflow-composition 16, goal-rehydrate 31, goal-verifier 30, loop-behavior 37, loop-caps-resume 48,
  plan-approval 52, safety-gates 61). No regression.
- External draft `composition-failure-recursion.e2e.mjs` → **16/16, EXIT 0** (still in `ignoredDraftSuites`, correct).

**Summary of the 8 passes (what was delivered):** durable behavioral coverage, executable from a clean checkout

(`tsc` only saw types; there are now 9 fault-injected e2e suites). P1-4: safety gates (safety-gates 61), independent goal verifier (goal-verifier 30), goal rehydration (goal-rehydrate 31), loop scheduling engine (loop-behavior 37). P5-6: runtime COMPOSITION — `lib/rank-candidates` + driver + composition-rank (13) and failure/direct recursion contracts (composition-failure-recursion 16, external draft). FINAL P7-8: STATIC graph composition (composition-graph-expansion 31), approval HANDSHAKE + plan lifecycle (plan-approval 52), and caps/pause-resume/rehydrate + untrusted autonomous loop re-entry gate (loop-caps-resume 48). Single runner `run-all.mjs` with drift guard. REAL defects found by the suites and fixed: `[Circular]` bug in rank-candidates best (P5), and this closing flakiness race. Zero edits to the hot core `dynamic-workflows.ts`.

**Pending / proposals for the human (non-blocking):**
- WIRE the e2e tests: `run-all.mjs` runs the suite manually; wiring it to CI / an npm script remains a human decision (`package.json` is outside the autopilot allowlist, so it was not touched).
- REGISTER the extensions / publish the package: outside autopilot scope (irreversible).
- PROPOSAL for core: add a second lib/driver to the recipe catalog (`composition-driver` currently only cites `lib/verify-claims`; `lib/rank-candidates` shows that composition is a general pattern).
- `/goal` non-interactive rehydrate gap in `extensions/goal.ts` (requires touching the extension; deferred, candidate for a dedicated e2e in a future loop).
- If the owner of `composition-failure-recursion.e2e.mjs` considers it stable, move it from `ignoredDraftSuites` to `suites` in `run-all.mjs`.

**VERDICT:** **done** — 8-pass cap reached. Everything green, no regression, hot core intact. My only runtime footprint in this closeout is the flakiness fix (test helper) in `examples/e2e/goal-rehydrate.e2e.mjs`, plus these log lines. No commit, no push, nothing irreversible (the orchestrator commits it).

---

## Final pass — 2026-06-25 15:53 -03

**Improvement / blocking fix:** hardened the `/plan` read-only gate to block mutations that reviews flagged as holes: creation/metadata commands (`mkdir`, `touch`, `chmod`, `chown`, `chgrp`) and write redirections with numbered fd such as `2>err.log`, while keeping the safe fd-dup `2>&1` allowed.

**Files:**
- `extensions/plan.ts`
- `examples/e2e/safety-gates.e2e.mjs`
- `docs/research/continuous-improvement-log.md` (this entry)

**Green verification:**
- `npm test` → EXIT 0.
- `npx --yes esbuild extensions/plan.ts --bundle --platform=node --format=esm --outfile=/tmp/pi-plan-check.mjs` → EXIT 0.
- `node --check examples/e2e/safety-gates.e2e.mjs` → OK.
- `node examples/e2e/safety-gates.e2e.mjs` → `TOTAL: 65 passed, 0 failed`.
- `node examples/e2e/run-all.mjs` → `9/9 suites passed`.

**Adversarial evidence:** the `safety-gates` suite now explicitly covers the previously missing cases: `mkdir generated`, `touch generated.txt`, `chmod +x script.sh`, `node test.js 2>err.log`; all are blocked by `/plan`, and `extensions/dynamic-workflows.ts`, `package.json`, and lockfiles were not touched. No commit, no push, no deletions.

---

## Pass — 2026-06-25 (requested pass closeout)

**Improvement / blocking fix applied:** no new code changes were applied in this pass because the editable files with relevant fixes were already modified at startup (`extensions/loop.ts`, `extensions/plan.ts`, `examples/e2e/run-all.mjs`) and, as a safeguard, were treated as external/hot changes. `extensions/dynamic-workflows.ts` was respected as a hot file: it was not touched. The safe action was to verify the current tree and record evidence.

**Files touched:**
- `docs/research/continuous-improvement-log.md` (this entry only).

**Verification:**
- `npm test` → EXIT 0.
- Included `npm run typecheck` and `npm run test:e2e`.
- e2e result: 11/11 suites passed.

**Evidence:**
- `git status --porcelain` before touching anything showed pre-existing changes in allowed and hot files (`extensions/dynamic-workflows.ts`, `extensions/loop.ts`, `extensions/plan.ts`, `examples/e2e/run-all.mjs`, among others), so those files were not edited.
- `npm test` green with the `bg-*`, composition, goal, loop, plan, and safety gates suites.

**Pass verdict:** DRY — there was no safe blocking fix left to apply without touching external changes; verification is green.
