# Project Instructions

## Engineering mindset

Adopt a Karpathy-style engineering mindset: build understanding from first principles, prefer small readable systems, and make complexity earn its place. When learning or designing, start with simple baselines, inspect the data/state directly, verify assumptions, test tiny or representative cases first, and add sophistication incrementally.

Use AI aggressively as a new programming interface, but do not confuse generation with correctness. AI is excellent for prototyping, exploration, scaffolding, and accelerating routine work; serious engineering still requires human taste, clear specifications, careful review of diffs, tests/evals, security awareness, and ownership of the final result.

For agentic work, treat prompts, context, tools, memory, artifacts, and evaluations as part of the program. Make the workflow observable: keep steps small, preserve evidence, expose uncertainty, verify outputs, and prefer inspectable artifacts over hidden magic.

## Coding guidelines

Use the installed `karpathy-guidelines` skill when writing, reviewing, or refactoring code. It contains the community Karpathy-inspired rules for thinking before coding, keeping solutions simple, making surgical changes, and driving work with verifiable goals.

Use the project `modern-software-engineering` skill for architecture, refactoring, code review, test strategy, delivery/process improvements, and dynamic workflow design. It distills Dave Farley-style Modern Software Engineering: default to TDD for behavior changes (Red → Green → Refactor), optimize for fast evidence, manage complexity deliberately, and judge changes by stability plus throughput.

Honor every TDD step, not just the easy two:

- **Red first.** Write the failing test BEFORE the implementation; test-after is not TDD. If you genuinely cannot go test-first, say so explicitly rather than labelling test-after as TDD.
- **Never silently skip Refactor.** After Green, always do the Refactor pass and NARRATE its outcome — even when the conclusion is "nothing to change", state that and why. The passing tests are the safety net that makes refactoring cheap; not using them is the miss.
- **The Refactor step is bounded by the self-contained-extension rule.** Pi loads each extension self-contained (a single file or its own dir via jiti filesystem resolution), so a `../shared/` runtime import only resolves while the whole monorepo is present and breaks when the extension is installed standalone. Therefore per-extension duplication is INTENTIONAL (see `pi-*/notify.ts`, `time.ts`, `session-state.ts`, and small per-extension flag parsers/prompt strings). Do NOT "DRY" runtime code across extensions into a shared module during Refactor; `extensions/shared/` is for TEST harness code only. Dedup only WITHIN a single extension/package.

Source/reference: [multica-ai/andrej-karpathy-skills](https://github.com/multica-ai/andrej-karpathy-skills). These guidelines are derived from Andrej Karpathy's notes on LLM coding pitfalls; they are not authored by him.

In this package, those principles are also operationalized as runtime mechanisms: `/plan` ≈ Think Before Coding, `/loop` safeguards ≈ Surgical Changes, and `/goal` + `/loop` ≈ Goal-Driven Execution. Behavior integration suites grouped by extension under `tests/<extension>/integration/` (run via `npm test`) keep them honest.

## Ultracode / dynamic workflows

For broad, high-confidence, or repo-wide tasks, use the Ultracode router (`/dynamic-workflow`, `/effort ultracode`, or `dynamic_workflow`) only when it earns its cost:

- Scout inline first with cheap read-only probes to discover the real work-list.
- Use dynamic workflows for scale, exhaustiveness, independent verification, or more context than one window.
- Prefer fresh task-specific drafts under the gitignored `.pi/workflows/drafts/<slug>.js`, next to `.pi/workflows/runs/`; reuse an existing workflow only when it exactly matches the task.
- Graph/start workflows in background with explicit `concurrency` and `maxAgents`, then inspect artifacts before trusting conclusions.
- Subagents get `web_search` and `context7-cli` by default when installed; opt out only when isolation is required.
- **`web_search` budget:** fast mode allows only ~10 sub-queries and each `web_search` call can fan out into several, so issue ONE narrow query per turn — do NOT fire multiple searches in parallel or add a `deep` call in the same turn, or the budget is exhausted and results fail. A single focused query often closes several evidence gaps at once.

## Scratch space

Use the gitignored `.pi/tmp/` directory for throwaway temporary files (scratch scripts, previews, ad-hoc experiments). Do not commit them and do not scatter temp files across the repo.

## Commits

- Use Conventional Commits with an explicit scope, for example `feat(dynamic-workflows): add monitor dashboard`.
- Keep commits atomic: each commit should contain one coherent change and its related docs/tests only.
- **Never `git commit --amend` blindly:** concurrent Pi sessions/tabs can land a commit on top of yours, so `HEAD` may not be the commit you think. Check `git log`/`git reflog` first, and only amend a commit you are certain is your own and is still `HEAD`. If you already mixed changes in, recover the original tree via `reflog` and `git reset --soft` to split them back out.
