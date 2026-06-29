# Project Instructions

## Engineering mindset

Adopt a Karpathy-style engineering mindset: build understanding from first principles, prefer small readable systems, and make complexity earn its place. When learning or designing, start with simple baselines, inspect the data/state directly, verify assumptions, test tiny or representative cases first, and add sophistication incrementally.

Use AI aggressively as a new programming interface, but do not confuse generation with correctness. AI is excellent for prototyping, exploration, scaffolding, and accelerating routine work; serious engineering still requires human taste, clear specifications, careful review of diffs, tests/evals, security awareness, and ownership of the final result.

For agentic work, treat prompts, context, tools, memory, artifacts, and evaluations as part of the program. Make the workflow observable: keep steps small, preserve evidence, expose uncertainty, verify outputs, and prefer inspectable artifacts over hidden magic.

## Coding guidelines

Use the installed `karpathy-guidelines` skill when writing, reviewing, or refactoring code. It contains the community Karpathy-inspired rules for thinking before coding, keeping solutions simple, making surgical changes, and driving work with verifiable goals.

Use the project `modern-software-engineering` skill for architecture, refactoring, code review, test strategy, delivery/process improvements, and dynamic workflow design. It distills Dave Farley-style Modern Software Engineering: default to TDD for behavior changes (Red → Green → Refactor), optimize for fast evidence, manage complexity deliberately, and judge changes by stability plus throughput.

Source/reference: [multica-ai/andrej-karpathy-skills](https://github.com/multica-ai/andrej-karpathy-skills). These guidelines are derived from Andrej Karpathy's notes on LLM coding pitfalls; they are not authored by him.

In this package, those principles are also operationalized as runtime mechanisms: `/plan` ≈ Think Before Coding, `/loop` safeguards ≈ Surgical Changes, and `/goal` + `/loop` ≈ Goal-Driven Execution. Behavior integration suites grouped by extension under `tests/<extension>/integration/` (run via `npm test`) keep them honest.

## Ultracode / dynamic workflows

For broad, high-confidence, or repo-wide tasks, use the Ultracode router (`/dynamic-workflow`, `/effort ultracode`, or `dynamic_workflow`) only when it earns its cost:

- Scout inline first with cheap read-only probes to discover the real work-list.
- Use dynamic workflows for scale, exhaustiveness, independent verification, or more context than one window.
- Prefer fresh task-specific drafts under the gitignored `.pi/workflows/drafts/<slug>.js`, next to `.pi/workflows/runs/`; reuse an existing workflow only when it exactly matches the task.
- Graph/start workflows in background with explicit `concurrency` and `maxAgents`, then inspect artifacts before trusting conclusions.
- Subagents get `web_search` and `context7-cli` by default when installed; opt out only when isolation is required.

## Scratch space

Use the gitignored `.pi/tmp/` directory for throwaway temporary files (scratch scripts, previews, ad-hoc experiments). Do not commit them and do not scatter temp files across the repo.

## Commits

- Use Conventional Commits with an explicit scope, for example `feat(dynamic-workflows): add monitor dashboard`.
- Keep commits atomic: each commit should contain one coherent change and its related docs/tests only.
