# Agentic patterns and papers applicable to Dynamic Workflows

Date: 2026-06-25

## Objective

Consolidate what we learned about agentic workflows and relevant papers to improve our Pi Dynamic Workflows: prompts, templates, examples, concurrency selection, and criteria for when to orchestrate.

## Sources reviewed

- **ReAct: Synergizing Reasoning and Acting in Language Models** — arXiv:2210.03629. Useful idea: alternate reasoning and actions/tools; in workflows, separate cheap scouting, execution with tools, and synthesis with evidence.
- **Self-Consistency Improves Chain of Thought Reasoning in Language Models** — arXiv:2203.11171. Useful idea: multiple independent paths + selection by consensus; in workflows, use perspective fan-out and synthesis-as-judge.
- **Reflexion: Language Agents with Verbal Reinforcement Learning** — arXiv:2303.11366. Useful idea: verbal memory of failures and reflection; in workflows, loops with error artifacts, retries, and verification.
- **Self-Refine: Iterative Refinement with Self-Feedback** — arXiv:2303.17651. Useful idea: generate → critique → refine; in workflows, plan → adversarial critique → revised plan → checklist.
- **Tree of Thoughts: Deliberate Problem Solving with Large Language Models** — arXiv:2305.10601. Useful idea: branch/evaluate/prune; in workflows, generate parallel alternatives, evaluate them by rubric, and prune before implementing.
- **Improving Factuality and Reasoning in Language Models through Multiagent Debate** — arXiv:2305.14325. Useful idea: multi-agent debate improves factuality; in workflows, independent reviewers and a judge that discards unsupported claims.
- **AutoGen: Enabling Next-Gen LLM Applications via Multi-Agent Conversation** — arXiv:2308.08155. Useful idea: programmable multi-agent conversation patterns; in workflows, explicit roles, output contracts, and tool scopes.
- **CAMEL: Communicative Agents for "Mind" Exploration of Large Language Model Society** — arXiv:2303.17760. Useful idea: role-play cooperation with defined roles; in workflows, `agentType` and non-overlapping responsibilities.
- **MetaGPT: Meta Programming for A Multi-Agent Collaborative Framework** — arXiv:2308.00352. Useful idea: encode human workflows into roles and artifacts; in workflows, stable artifacts and explicit phases.
- **AgentVerse: Facilitating Multi-Agent Collaboration and Exploring Emergent Behaviors** — arXiv:2308.10848. Useful idea: dynamically adjust group composition; in workflows, choose the number/type of agents after scouting.
- **SWE-agent: Agent-Computer Interfaces Enable Automated Software Engineering** — arXiv:2405.15793. Useful idea: the agent-computer interface matters; in workflows, restricted tools, prompts with paths/commands, and inspectable artifacts.
- **DSPy: Compiling Declarative Language Model Calls into Self-Improving Pipelines** — arXiv:2310.03714. Useful idea: declarative modules and contracts; in workflows, schemas, fixed formats, and reusable helpers.

## Derived principles

1. **Dynamic-first, not hardcode-first**
   - Create task-specific workflows dynamically; versioned examples are references, not fixed jobs.
   - Treat generated workflows as drafts under `generated/<task-slug>` and promote them to stable names only if the user liked them or wants to reuse them.
   - Do not fix the number of agents/concurrency without examining the problem.
   - Scout inline or inside the workflow, measure the work list, and choose fan-out based on size, cost, risk, and the request.

2. **Fan-out only with real independence**
   - Use `ctx.agents` for independent items.
   - Use `ctx.pipeline` when each item requires several stages of its own.
   - Use `ctx.parallel` only if there is a real barrier: global deduplication, cross-ranking, consensus, or judge.

3. **Synthesis-as-judge, not passive summary**
   - The synthesizer must judge, not average.
   - It must discard unsupported claims, resolve contradictions, and preserve uncertainty.

4. **Evidence as contract**
   - Each subagent must cite file/line, URL, observed command, or declare `NO_FINDINGS` / `INSUFFICIENT_EVIDENCE`.
   - Findings without evidence do not make it into the final output.

5. **Visible partial failure**
   - Use `settle:true` in large fan-outs.
   - Filter `null`, log how many branches failed, and require the synthesis to mention partial coverage.

6. **Loops with an explicit brake**
   - Reflexion/Self-Refine suggest loops, but they must have a stop condition: max rounds, quiet rounds, maxAgents, timeout, or budget.
   - Use `{ cache:false }` only when deliberately seeking a new sample.

7. **Minimal roles and tools**
   - Role specialization: reviewer, researcher, planner, implementer.
   - For audits, read-only tools.
   - For implementation, separate plan/review from actual editing.

8. **Artifacts as external memory**
   - Persist the work list, raw outputs, discarded items, synthesis, checks, and accepted risks.
   - Do not depend on everything fitting into the chat context.

## Changes applied

- README: added research-backed patterns and an explanation of dynamic workflows/dynamic concurrency.
- `dynamic-workflows` skill: strengthened decision rules, patterns, and partial failure.
- Base template: now scouts, logs caps, chooses concurrency dynamically, and uses `settle:true`.
- Examples: `repo-bug-hunt`, `deep-research`, and `adversarial-plan-review` now choose concurrency dynamically, log partial failures, and use personas/settling.
- Explicit Ultracode: `/ultracode` now forces a more operational instruction ("create a task-specific workflow dynamically with `dynamic_workflow` in this turn if it passes the gate"), prefers `generated/<task-slug>` as a draft, and activates the `dynamic_workflow` tool if it was inactive.
- TUI/widget: hardened rendering for `width <= 0` and sanitize log messages before rendering.
- Updated policy: `examples/` must not contain `.pi`; open Pi from the repo root or copy examples to a temporary project.

## Validation

```bash
node --check examples/workflows/repo-bug-hunt.js examples/workflows/deep-research.js examples/workflows/adversarial-plan-review.js
npx --yes esbuild extensions/dynamic-workflows.ts --platform=node --format=esm --packages=external --outfile=/tmp/pi-dynamic-workflows-check.mjs
./node_modules/.bin/tsc --noEmit --skipLibCheck --target ES2022 --module NodeNext --moduleResolution NodeNext --types node extensions/dynamic-workflows.ts
pi --no-extensions -e ./extensions/dynamic-workflows.ts --list-models __no_such_model__
PI_DYNAMIC_WORKFLOWS_PI_COMMAND=true pi --no-extensions -e ./extensions/dynamic-workflows.ts --no-session -p "/ultracode-mode status"
```

From `examples/`:

```bash
PI_DYNAMIC_WORKFLOWS_PI_COMMAND=true pi --no-session -p "/workflow list"
```

## Recommended next steps

- Add pattern scaffolds: `judge-panel`, `adversarial-verify`, `loop-until-dry`, `multi-modal-sweep`, `pipeline`.
- Add pre-run linting to detect silent caps and hardcoded concurrency.
- Improve always-on `/ultracode` so it distinguishes "decide workflow" from "force workflow" and logs the decision when it affects cost/latency.
