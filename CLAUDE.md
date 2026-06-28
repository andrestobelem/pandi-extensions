# Project Instructions

## Engineering mindset

Adopt a Karpathy-style engineering mindset: build understanding from first principles, prefer small readable systems, and make complexity earn its place. When learning or designing, start with simple baselines, inspect the data/state directly, verify assumptions, test tiny or representative cases first, and add sophistication incrementally.

Use AI aggressively as a new programming interface, but do not confuse generation with correctness. AI is excellent for prototyping, exploration, scaffolding, and accelerating routine work; serious engineering still requires human taste, clear specifications, careful review of diffs, tests/evals, security awareness, and ownership of the final result.

For agentic work, treat prompts, context, tools, memory, artifacts, and evaluations as part of the program. Make the workflow observable: keep steps small, preserve evidence, expose uncertainty, verify outputs, and prefer inspectable artifacts over hidden magic.

## Coding guidelines

Behavioral guidelines to reduce common LLM coding mistakes. Adapted from the community "Karpathy" CLAUDE.md ([multica-ai/andrej-karpathy-skills](https://github.com/multica-ai/andrej-karpathy-skills)) — derived from Andrej Karpathy's notes on LLM coding pitfalls, not authored by him. Merge with the project-specific instructions above.

**Tradeoff:** these bias toward caution over speed. For trivial tasks, use judgment.

### 1. Think Before Coding — Don't assume. Don't hide confusion. Surface tradeoffs.

- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them — don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

### 2. Simplicity First — Minimum code that solves the problem. Nothing speculative.

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

### 3. Surgical Changes — Touch only what you must. Clean up only your own mess.

- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it — don't delete it.
- Remove imports/variables/functions that YOUR changes made unused; don't remove pre-existing dead code unless asked.

The test: every changed line should trace directly to the user's request.

### 4. Goal-Driven Execution — Define success criteria. Loop until verified.

Transform tasks into verifiable goals:

- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan (`1. [Step] → verify: [check]`). Strong success criteria let you loop independently; weak criteria ("make it work") require constant clarification.

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.

> In this package these principles are operationalized as runtime mechanisms: the `/plan` extension (read-only plan mode until approved) ≈ Think Before Coding; the `/loop` safeguards (touch only your own files, never hot/foreign ones) ≈ Surgical Changes; `/goal` + `/loop` (success criteria + independent verification, loop until done) ≈ Goal-Driven Execution. Behavior integration suites grouped by extension under `tests/<extension>/integration/` (run via `npm test`) keep them honest.

## Scratch space

Use the gitignored `.pi/tmp/` directory for throwaway temporary files (scratch scripts, previews, ad-hoc experiments). Do not commit them and do not scatter temp files across the repo.

## Commits

- Use Conventional Commits with an explicit scope, for example `feat(dynamic-workflows): add monitor dashboard`.
- Keep commits atomic: each commit should contain one coherent change and its related docs/tests only.
