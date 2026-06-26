# Improving prompts for dynamic workflows

Date: 2026-06-25

## Objective

Apply what we learned about agentic workflow patterns to the prompts used by our dynamic workflows.

## Applied patterns

- **Independent fan-out**: each subagent receives instructions to produce a self-contained result, even if other agents fail.
- **Evidence contract**: require citations to files/lines, URLs, observed commands, or marking `INSUFFICIENT_EVIDENCE` / `NO_FINDINGS`.
- **Fixed format**: prompts ask for repeatable sections such as verdict, findings, evidence, risks, fix, and verification.
- **Synthesis-as-judge**: synthesis agents must deduplicate, discard claims without evidence, preserve uncertainty, and choose a concrete recommendation.
- **Adversarial critique**: reviewers have an explicit goal of finding edge cases, reducing scope, and marking accepted risks.
- **Partial failure handling**: synthesis must mention failed, empty, canceled, or timed-out agents.
- **Security by default**: for audits, “do not edit files” is reinforced and tools remain read-only.

## Updated workflows

- `.pi/workflows/agentic-workflow-patterns-research.js`
- `.pi/workflows/background-workflow-implementation-plan.js`
- `.pi/workflows/review-dynamic-workflows.js`
- `.pi/workflows/revisar-estado-actual.js`
- `.pi/workflows/inventar-mejor-tui-workflows.js`
- `.pi/workflows/inventar-mejor-tui-workflows-lite.js`
- `.pi/workflows/karpathy-programming-recommendations-research.js`
- `examples/workflows/adversarial-plan-review.js`
- `examples/workflows/deep-research.js`
- `examples/workflows/repo-bug-hunt.js`

## Updated docs

- `README.md`: “Recommended prompt patterns” section.
- `.pi/skills/dynamic-workflows/SKILL.md`: “Prompting Patterns” section.
- `docs/memoria.md`: persistent preference.
- `docs/research/2026-06-25-karpathy-programming-recommendations.md`: synthesis retrieved from Karpathy as prompt/workflow criteria.

## Decisions

- Another workflow was not launched for this task because the latest workflows with subagents hung without visible processes. A direct, verifiable refactor was done instead.
- A shared prompt helper was not added yet to avoid coupling simple examples to the internal runtime.
- Improving prompts was prioritized over changing the API.

## Expected validation

- `node --check` on all JS workflows.
- Extension load with `pi --no-extensions -e ./extensions/dynamic-workflows.ts --list-models __no_such_model__`.
