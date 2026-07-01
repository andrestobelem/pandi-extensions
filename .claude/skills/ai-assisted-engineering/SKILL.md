---
name: ai-assisted-engineering
description: >-
  Apply Andrej Karpathy-style judgment when building software with AI or agents:
  build small things to understand, separate prototyping/vibe-coding from
  production, treat prompts/context/tools as the program (Software 3.0), debug
  incrementally from simple baselines, and keep the human as specifier,
  evaluator, and owner of correctness. Use when deciding how much to delegate to
  AI, whether AI output is trustworthy, or how to design agentic/dynamic
  workflows.
---

# AI-Assisted Engineering

Use this skill when a task involves **using AI or agents to build software** and the real question is judgment: how much to delegate, whether generated output can be trusted, when to prototype freely versus when to verify, and how to design agentic/dynamic workflows so a human stays in control.

This skill is based on the project research distilled from Andrej Karpathy's recommendations on programming, learning, and using AI (Software 2.0/3.0, vibe coding, "A Recipe for Training Neural Networks", micrograd/nanoGPT). See `references/karpathy-programming-recommendations.md` for the compact source summary.

It is the AI-era companion to the `modern-software-engineering` skill: that one supplies the TDD/feedback/complexity discipline, this one supplies the discipline for *where AI fits inside it*.

## Core lens

1. **Build small things from scratch to understand.** Prefer small, readable, complete implementations over hidden magic. Understanding the system is the asset; the code is a means to it (micrograd, nanoGPT, Zero to Hero).
2. **Understand before delegating.** AI lowers the friction of *creating*; it does not replace technical judgment when the system matters. Use agents to accelerate, never to skip review, tests, or evidence.
3. **Software 3.0: prompts/context/tools are the program.** LLMs are programmed through prompts, examples, memory, context, and scoped tools. Treat those as first-class engineering artifacts — designed, versioned, and inspectable — not as throwaway details.
4. **Vibe-code prototypes; do not vibe-code production.** Free-form generation is excellent for demos, personal apps, and rapid exploration. Production needs specifications, permissions, diff review, tests/evals, security, and a human owner. Separate "explore/generate" from "verify/commit" and make visible what was actually validated.
5. **Debug incrementally from simple baselines.** Inspect the data/inputs, start simple, verify assumptions, overfit a tiny case, then add complexity gradually. Cheap scout and smoke test before any large fan-out.
6. **The expert's role shifts to specifying, evaluating, and debugging.** As AI writes more code, the human's work moves toward managing context, reviewing outputs, designing tests/evals, and *deciding whether something is correct*.

## Required response shape when using this skill

For a plan, review, or implementation that leans on AI/agents, include these unless clearly irrelevant:

- **Trust level:** is this prototype/exploration (vibe-coding OK) or production/serious (specs + verification required)? Say which.
- **Delegation boundary:** what the AI/agent does vs. what the human specifies, reviews, and owns.
- **Smallest understandable slice:** the narrowest, most inspectable increment — favor a small readable implementation over a broad generated one.
- **Verification plan:** the tests, evals, diff review, or executable check that decides correctness — *not* agent consensus.
- **Stop/escalate condition:** what evidence is enough to ship, and what forces a human back into the loop.

## How to apply it

1. **Classify the stakes first.** Prototype/demo/personal → optimize for speed and learning, generation is fine. Production/shared/risky → require specs, review, tests, security, ownership.
2. **Delegate to accelerate, not to abdicate.** Let AI draft, search, refactor, and explore; keep the human owning the spec, the review, and the decision that it is correct.
3. **Design the prompt/context as a program.** Give each agent an evidence contract, allowed tools, output format/schema, and stop conditions. Make context explicit and scoped rather than implicit and broad.
4. **Build the smallest understandable thing.** Prefer a small readable implementation you can inspect and modify over a large opaque one — even if AI could generate the large one faster.
5. **Start simple, add complexity on evidence.** Cheap scout → simple baseline → verify assumptions → overfit a small case → expand. Add caps, smoke tests, and artifacts before large fan-outs.
6. **Verify with executable evidence.** Treat AI/agent output as a hypothesis. Confirm with tests, evals, reproduction, diff review, or external checks before accepting it.
7. **Keep the human supervising.** Surface status, agents, evidence, and partial failures so a person can specify, evaluate, and debug — not just watch calls go by.

## Checklist (AI/agent-assisted work)

- **Stakes:** Is this prototype or production? Does the rigor match?
- **Ownership:** Is it clear what the human specifies, reviews, and is accountable for?
- **Understanding:** Could you explain and modify this code, or is it opaque generated magic?
- **Size:** Is this the smallest inspectable slice, or a broad speculative generation?
- **Prompt-as-program:** Do agents have an evidence contract, scoped tools, output format, and stop conditions?
- **Baseline-first:** Did a cheap scout / simple baseline precede the large fan-out?
- **Verification:** What executable check (test, eval, reproduction, diff review) confirms correctness — beyond "the model said so"?
- **Partial failure:** Are failed/empty/stale agent branches visible, or hidden behind a confident summary?
- **Security/permissions:** For anything beyond a toy, are auth, secrets, permissions, and blast radius handled?

## Dynamic workflow guidance

For Pi Dynamic Workflows specifically:

- Make the **agentic pattern** visible (fan-out, judge, feedback, pipeline, routing), not just "which call happened" — the pattern *is* the program.
- Write prompts as readable programs: evidence contract, allowed tools, output format, and stop conditions; push volatile per-item content to the end.
- Keep example/generated workflows small, inspectable, and modifiable (micrograd/nanoGPT spirit) — avoid hidden magic.
- Separate explore/generate stages from verify/commit stages; never let a synthesis stand without synthesis-as-judge, tests, or external verification when correctness matters.
- Start broad workflows with a cheap scout and a simple baseline; set `maxAgents`, concurrency, model, and caps from stakes and the learning goal, and `log()` whatever you bound.

## Anti-patterns to call out

- Shipping vibe-coded output to production without specs, review, tests, evals, security, or a human owner.
- Treating AI/agent consensus or generated code as equivalent to a passing test.
- Generating large opaque code when a small readable implementation would teach more and be safer to change.
- Jumping to a large fan-out / complex pipeline before a cheap scout and a simple baseline.
- Leaving prompts, context, and tool scope implicit and unversioned while treating only the code as "the program".
- Hiding partial agent failures behind a confident summary.

## Guardrails

- Match rigor to stakes: do not impose production ceremony on a throwaway prototype, and do not vibe-code anything users or systems depend on.
- Use AI to shorten loops, not to skip understanding, review, or verification.
- Do not confuse fluent generated output with correctness; require executable evidence and human ownership.
- If the cheapest next step is a small readable implementation, a simple baseline, or a single decisive test, prefer that over a large generation or orchestration.
