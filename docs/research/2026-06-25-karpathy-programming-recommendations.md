# Andrej Karpathy’s recommendations for programming, learning, and using AI

Date: 2026-06-25

## Objective

Recover and integrate the research block on Andrej Karpathy that had been referenced but was not available in the repository. The historical workflow was restored, and an actionable synthesis was left for use as criteria in Dynamic Workflows, prompts, and agent UX.

## Recovered workflow

- Restored from `HEAD`:
  - `.pi/workflows/karpathy-programming-recommendations-research.js`
- Purpose of the workflow:
  - Research with fan-out by angles: primary sources, learning programming/ML, AI-assisted coding, engineering principles, and skeptical verification.
  - Synthesize in Spanish with this format: recommendation, primary evidence, quote/paraphrase, confidence, and applicability.

## Main sources identified

- Andrej Karpathy homepage: https://karpathy.ai/
- Sequoia Ascent 2026 summary / Software 3.0 / agentic engineering: https://karpathy.bearblog.dev/sequoia-ascent-2026/
- Vibe coding MenuGen: https://karpathy.bearblog.dev/vibe-coding-menugen/
- Software 2.0: https://karpathy.medium.com/software-2-0-a64152b37c35
- A Recipe for Training Neural Networks: https://karpathy.github.io/2019/04/25/recipe/
- micrograd: https://github.com/karpathy/micrograd
- nanoGPT: https://github.com/karpathy/nanoGPT
- Empirical cross-check on vibe coding: https://arxiv.org/abs/2506.23253

## Practical synthesis

1. **Learn by building from scratch**
   - Karpathy often favors small, readable, complete implementations to understand fundamentals.
   - Evidence: `micrograd`, `nanoGPT`, Zero to Hero, and his educational material indexed from `karpathy.ai`.
   - Application in Pi: examples/workflows should be small, inspectable, and modifiable; avoid hidden magic.

2. **Understand before delegating**
   - AI lowers the friction for creating, but it does not replace technical judgment when the system matters.
   - Evidence: posts on vibe coding and Software 3.0; in MenuGen he documents real frictions around auth, payments, deploy, API, and reliability.
   - Application in Pi: use agents to accelerate, but preserve human review, tests, and evidence.

3. **Software 3.0: programming with prompts/context/tools**
   - Karpathy frames an evolution: Software 1.0 = explicit code, Software 2.0 = learned weights, Software 3.0 = LLMs programmed through prompts, context, examples, memory, and tools.
   - Application in Dynamic Workflows: prompts, artifacts, schemas, scoped tools, and dashboard are part of the programming interface, not secondary details.

4. **Vibe coding works very well for prototypes, not as a production guarantee**
   - Useful for personal apps, demos, and rapid exploration.
   - Production requires specifications, permissions, diff review, tests/evals, security, and human ownership.
   - Application in Pi: separate “explore/generate” from “verify/commit”; make visible what was validated.

5. **Incremental debugging and simple baselines**
   - In “A Recipe for Training Neural Networks,” he recommends inspecting data, starting simple, verifying assumptions, overfitting small cases, and adding complexity gradually.
   - Application in Pi: complex workflows should have a cheap scout, visible caps, smoke tests, and artifacts before large fan-outs.

6. **The expert’s role shifts toward specifying, evaluating, and debugging**
   - AI use shifts part of the work from writing code to managing context, reviewing outputs, designing tests, and deciding whether something is correct.
   - Application in Pi: dashboard/graph should show status, agents, evidence, and partial failures so the human can supervise.

## Implications for this project

- Workflow visualization must show not only “which call happened,” but which agentic programming pattern is being used: fan-out, judge, feedback, pipeline, routing.
- Prompts should function as readable “programs”: evidence contract, allowed tools, output format, and stop conditions.
- Examples should favor small and educational implementations, in line with `micrograd`/`nanoGPT`: easy to read and run.
- For serious tasks, never treat an agent output as truth without synthesis-as-judge, tests, or external verification.

## Validation

```bash
node --check .pi/workflows/karpathy-programming-recommendations-research.js
```

## Optional next step

Update the restored workflow to the runtime’s newer patterns (`settle:true`, `agentType:"researcher"`, partial-failure logging, and more explicit dynamic concurrency) without losing its original primary-source contract.
