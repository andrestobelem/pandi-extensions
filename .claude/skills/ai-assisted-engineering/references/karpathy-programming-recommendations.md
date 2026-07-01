# Andrej Karpathy — programming, learning, and using AI (compact source summary)

Distilled source for the `ai-assisted-engineering` skill. Fuller project research:
`docs/research/2026-06-25-karpathy-programming-recommendations.md`.

## Primary sources

- Homepage: https://karpathy.ai/
- Sequoia Ascent 2026 / Software 3.0 / agentic engineering: https://karpathy.bearblog.dev/sequoia-ascent-2026/
- Vibe coding MenuGen: https://karpathy.bearblog.dev/vibe-coding-menugen/
- Software 2.0: https://karpathy.medium.com/software-2-0-a64152b37c35
- A Recipe for Training Neural Networks: https://karpathy.github.io/2019/04/25/recipe/
- micrograd: https://github.com/karpathy/micrograd
- nanoGPT: https://github.com/karpathy/nanoGPT
- Empirical cross-check on vibe coding: https://arxiv.org/abs/2506.23253

## Practical synthesis

1. **Learn by building from scratch.** Small, readable, complete implementations to
   understand fundamentals; avoid hidden magic (micrograd, nanoGPT, Zero to Hero).
2. **Understand before delegating.** AI lowers the friction of creating but does not
   replace technical judgment when the system matters (vibe-coding MenuGen documents
   real frictions: auth, payments, deploy, API, reliability).
3. **Software 3.0.** Software 1.0 = explicit code; 2.0 = learned weights; 3.0 = LLMs
   programmed via prompts, context, examples, memory, and tools. Those are part of the
   programming interface, not secondary details.
4. **Vibe coding ≠ production guarantee.** Great for prototypes, demos, personal apps,
   rapid exploration. Production needs specs, permissions, diff review, tests/evals,
   security, and human ownership. Separate explore/generate from verify/commit.
5. **Incremental debugging and simple baselines.** Inspect the data, start simple, verify
   assumptions, overfit a small case, add complexity gradually ("A Recipe for Training
   Neural Networks").
6. **The expert's role shifts** toward specifying, evaluating, and debugging — managing
   context, reviewing outputs, designing tests, and deciding whether something is correct.

## Implications for this project

- Visualize *which agentic pattern* is in use (fan-out, judge, feedback, pipeline,
  routing), not just which call happened.
- Prompts are readable "programs": evidence contract, allowed tools, output format, stop
  conditions.
- Favor small, educational, runnable examples (micrograd/nanoGPT).
- For serious tasks, never treat agent output as truth without synthesis-as-judge, tests,
  or external verification.
