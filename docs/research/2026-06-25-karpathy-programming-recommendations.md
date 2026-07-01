# Andrej Karpathy's recommendations for programming, learning, and using AI

Date: 2026-06-25

## Objective

Recover and apply research on Andrej Karpathy's programming principles to Dynamic Workflows, prompts, and agent UX. The historical workflow was restored from `HEAD` (`.pi/workflows/karpathy-programming-recommendations-research.js`), synthesizing primary sources on learning, AI-assisted coding, and engineering judgment.

## Recovered workflow

Restored from `.pi/workflows/karpathy-programming-recommendations-research.js`.

**Research approach:** fan-out by angles (primary sources, learning programming/ML, AI-assisted coding, engineering principles, skeptical verification) and synthesize with evidence, quotes, confidence, and applicability.

## Main sources

- [Andrej Karpathy homepage](https://karpathy.ai/)
- [Sequoia Ascent 2026 summary: Software 3.0 & agentic engineering](https://karpathy.bearblog.dev/sequoia-ascent-2026/)
- [Vibe coding MenuGen](https://karpathy.bearblog.dev/vibe-coding-menugen/)
- [Software 2.0](https://karpathy.medium.com/software-2-0-a64152b37c35)
- [A Recipe for Training Neural Networks](https://karpathy.github.io/2019/04/25/recipe/)
- [micrograd](https://github.com/karpathy/micrograd) and [nanoGPT](https://github.com/karpathy/nanoGPT) repositories
- [Empirical cross-check on vibe coding](https://arxiv.org/abs/2506.23253)

## Practical synthesis

### 1. Learn by building from scratch

**Principle:** Small, readable, complete implementations reveal fundamentals.

**Evidence:** `micrograd`, `nanoGPT`, Zero to Hero, and educational material on karpathy.ai.

**Application:** Pi examples/workflows should be inspectable, modifiable, and avoid hidden magic.

### 2. Understand before delegating

**Principle:** AI lowers friction but does not replace technical judgment for systems that matter.

**Evidence:** Posts on vibe coding and Software 3.0; MenuGen documents real frictions around auth, payments, deploy, API, and reliability.

**Application:** Use agents to accelerate, but preserve human review, tests, and evidence.

### 3. Software 3.0: Programming with prompts, context, and tools

**Principle:** Evolution from Software 1.0 (explicit code) → Software 2.0 (learned weights) → Software 3.0 (LLMs programmed via prompts, context, examples, memory, tools).

**Application:** In Dynamic Workflows, prompts, artifacts, schemas, scoped tools, and dashboards are part of the programming interface, not secondary details.

### 4. Vibe coding for prototypes, not production

**Principle:** Useful for personal apps, demos, and rapid exploration. Production requires specs, review, tests/evals, security, and human ownership.

**Application:** Separate "explore/generate" from "verify/commit"; make visible what was validated.

### 5. Incremental debugging and simple baselines

**Principle:** Inspect data, start simple, verify assumptions, overfit small cases, add complexity gradually.

**Evidence:** "A Recipe for Training Neural Networks."

**Application:** Complex workflows need cheap scouts, visible caps, smoke tests, and artifacts before large fan-outs.

### 6. The expert's role shifts toward specifying, evaluating, and debugging

**Principle:** AI use shifts work from writing code to managing context, reviewing outputs, designing tests, and verifying correctness.

**Application:** Dashboards and graphs should show status, agents, evidence, and partial failures so humans can supervise.

## Implications for this project

- **Workflow visualization:** Show not only calls but the agentic pattern in use (fan-out, judge, feedback, pipeline, routing).
- **Prompts as programs:** Make evidence contracts, allowed tools, output formats, and stop conditions readable.
- **Examples:** Favor small, educational implementations (micrograd/nanoGPT style) that are easy to read and run.
- **Verification:** For serious tasks, use synthesis-as-judge, tests, or external verification; never treat agent output as truth without evidence.

## Validation

```bash
node --check .pi/workflows/karpathy-programming-recommendations-research.js
```

## Next step

Update the restored workflow to runtime patterns (`settle:true`, `agentType:"researcher"`, partial-failure logging, explicit concurrency) while preserving its primary-source contract.
