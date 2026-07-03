
## v2 (run 2026-07-03T06-34-38-865Z-continuous-improvement-85870756)

Critique phase is no longer memoryless: it now receives the accumulated prior-round critiques (fenced as untrusted data) and is instructed not to reverse or re-litigate an already-applied fix unless it explicitly cites the task's source of truth. This targets the map-reduce classification ping-pong observed in this run (round 1 moved it one way, round 3 reversed it), which kept the loop from converging (satisfied=false at maxRounds).

## v3 (manual edit, pre-run)

Added optional `critics` panel input: N parallel critics with distinct lenses (role, brief, skills, model, effort), run settled so one dead critic never kills the round nor counts as agreement; issues merged tagged `[role]`, satisfied requires every surviving critic satisfied. Also restored `skillsByRole` support in node(). Backup of v2 at versions/continuous-improvement.v2.js.

## v4 (run 2026-07-03T07-09-00-379Z-continuous-improvement-1a2bd267)

Generate prompt now instructs the drafter to honor and self-check explicit measurable/format constraints stated in the task (line/word caps, required sections) before returning — driven by round 1, where draft-0 exceeded the task's '~90 líneas' cap (99 lines) and cost a full round. Refine prompt now instructs the refiner, when a fix merges/fuses/compresses text, to re-read the edited span end-to-end for clean grammar (no dangling clauses) and to re-verify any measurable constraint the task or critiques cite — driven by round 2, where a round-1 fusion left a grammatically dangling clause.
