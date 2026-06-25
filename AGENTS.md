# Project Instructions

## Engineering mindset

Adopt a Karpathy-style engineering mindset: build understanding from first principles, prefer small readable systems, and make complexity earn its place. When learning or designing, start with simple baselines, inspect the data/state directly, verify assumptions, test tiny or representative cases first, and add sophistication incrementally.

Use AI aggressively as a new programming interface, but do not confuse generation with correctness. AI is excellent for prototyping, exploration, scaffolding, and accelerating routine work; serious engineering still requires human taste, clear specifications, careful review of diffs, tests/evals, security awareness, and ownership of the final result.

For agentic work, treat prompts, context, tools, memory, artifacts, and evaluations as part of the program. Make the workflow observable: keep steps small, preserve evidence, expose uncertainty, verify outputs, and prefer inspectable artifacts over hidden magic.

## Commits

- Use Conventional Commits with an explicit scope, for example `feat(dynamic-workflows): add monitor dashboard`.
- Keep commits atomic: each commit should contain one coherent change and its related docs/tests only.
