
## v2 (run 2026-07-03T06-34-38-865Z-continuous-improvement-85870756)

Critique phase is no longer memoryless: it now receives the accumulated prior-round critiques (fenced as untrusted data) and is instructed not to reverse or re-litigate an already-applied fix unless it explicitly cites the task's source of truth. This targets the map-reduce classification ping-pong observed in this run (round 1 moved it one way, round 3 reversed it), which kept the loop from converging (satisfied=false at maxRounds).

## v3 (manual edit, pre-run)

Added optional `critics` panel input: N parallel critics with distinct lenses (role, brief, skills, model, effort), run settled so one dead critic never kills the round nor counts as agreement; issues merged tagged `[role]`, satisfied requires every surviving critic satisfied. Also restored `skillsByRole` support in node(). Backup of v2 at versions/continuous-improvement.v2.js.

## v4 (run 2026-07-03T07-09-00-379Z-continuous-improvement-1a2bd267)

Generate prompt now instructs the drafter to honor and self-check explicit measurable/format constraints stated in the task (line/word caps, required sections) before returning — driven by round 1, where draft-0 exceeded the task's '~90 líneas' cap (99 lines) and cost a full round. Refine prompt now instructs the refiner, when a fix merges/fuses/compresses text, to re-read the edited span end-to-end for clean grammar (no dangling clauses) and to re-verify any measurable constraint the task or critiques cite — driven by round 2, where a round-1 fusion left a grammatically dangling clause.

## v5 (run 2026-07-03T10-51-45-708Z-continuous-improvement-6051ab2f)

Refine phase now retries once on a null return before aborting the loop: the refine prompt is hoisted into a `refinePrompt` variable and, if the first `agent()` call returns null, a single `refine-<round>-retry` attempt runs before setting failureNote. Motivated by this run's sole failure (`round 2: refiner returned null`) that killed an otherwise-progressing loop and threw away two actionable critiques; a transient single null no longer aborts the run.

## v6 (run 2026-07-03T10-51-45-708Z-continuous-improvement-6051ab2f)

Refine prompt now tells the refiner to apply a critique's concrete fix (shell command, regex, glob, or path) VERBATIM instead of paraphrasing it — paraphrase silently drifts (e.g. a working `git grep … **.ts` becoming a plain `grep … **.ts` that no longer recurses), which was making the same issue recur every round — and to RUN every command/regex/glob it adds or edits against the cited example (when shell tools are available) to confirm the expected output before marking an issue resolved. The Generate prompt gains the matching discipline: when the task requires commands/regexes/code that must actually run or be verifiable, execute them against real inputs and fix failures before returning. No structural, phase, guardrail, or threshold changes.
