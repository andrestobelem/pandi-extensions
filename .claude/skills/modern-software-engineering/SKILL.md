---
name: modern-software-engineering
description: >-
  Apply Dave Farley-style Modern Software Engineering principles when designing,
  reviewing, or improving software systems, dynamic workflows, tests, delivery
  pipelines, or engineering practices. Use to optimize for learning, make TDD
  the default feedback loop for behavior changes, manage complexity, and judge
  changes by stability plus throughput.
---

# Modern Software Engineering

Use this skill when a task asks for software engineering judgment: architecture, refactoring, code review, test strategy, delivery/process improvements, workflow design, or deciding whether a change is worth making.

This skill is based on the project research distilled from Dave Farley’s _Modern Software Engineering: Doing What Works to Build Better Software Faster_ and related notes. See `references/dave-farley-modern-software-engineering.md` for the compact source summary.

## Core lens

Modern software engineering is practical science applied to software development:

1. **Optimize for learning.** Treat each change as a hypothesis and seek the fastest high-quality feedback.
2. **Use TDD for behavior changes.** Start with a failing executable check, make it pass with the smallest change, refactor while preserving green tests, then land it as an atomic Conventional Commit with an explicit scope.
3. **Manage complexity.** Keep systems understandable enough to change safely.
4. **Use evidence.** Prefer tests, CI output, runtime observations, and preserved artifacts over fashion, authority, intuition, or AI consensus.
5. **Judge by stability and throughput.** A practice is useful when it improves quality/reliability/recovery and/or frequent efficient delivery without hurting the other dimension.

## TDD as the default feedback loop

For behavior-changing work, prefer TDD as the first learning mechanism:

1. **Name the behavior or risk being learned.** What uncertainty are we reducing?
2. **Red:** write or describe the smallest failing test/check that exposes it. For bugs, reproduce the bug. For refactors, add characterization tests. For new behavior, specify the expected behavior in a test.
3. **Green:** make the smallest implementation change that passes.
4. **Refactor:** improve names, boundaries, cohesion, coupling, duplication, and clarity while tests stay green.
5. **Verify:** run the relevant local checks and CI signal; capture the exact command/result when possible.
6. **Commit:** land the change as an atomic commit using Conventional Commits with an explicit scope (e.g. `fix(pandi-goal): …`). One coherent change per commit, with the pinning test in the SAME commit as the code it covers.

If TDD is not the right tool for the task, say why and name the replacement evidence: spike result, CI signal, runtime observation, user feedback, metric, or other executable check.

## Required response shape when using this skill

For plans, reviews, or implementation guidance, include these items unless clearly irrelevant:

- **Learning goal:** the uncertainty or risk being tested.
- **Smallest safe step:** the narrowest reversible slice.
- **TDD/feedback plan:** the failing test or check to create first, or the explicit replacement evidence.
- **Complexity check:** impact on modularity, cohesion, separation of concerns, information hiding, abstraction, and coupling.
- **Stability/throughput check:** expected effect on reliability, recovery, delivery speed, and change safety.
- **Stop condition:** what evidence is enough to proceed, stop, or roll back.

## How to apply it

When helping with a design, review, plan, implementation, or dynamic workflow:

1. **State the learning goal as a testable hypothesis.** What observation would prove it wrong?
2. **Choose the smallest useful slice.** Prefer a reversible increment, spike, or narrow workflow over a broad rewrite.
3. **Start with TDD for behavior changes.** Name the failing test, fixture, golden output, smoke check, CI signal, or measurement that will prove/disprove the hypothesis.
4. **Keep increments small and reversible.** Avoid large speculative rewrites unless measured evidence demands them.
5. **Reduce complexity deliberately.** Check modularity, cohesion, separation of concerns, information hiding, abstraction boundaries, and coupling during the refactor step, not as speculative design.
6. **Evaluate stability and throughput.** Explain expected impact on quality, reliability, recovery, deployment frequency, and delivery efficiency.
7. **Report evidence, not confidence.** End with commands, test/CI results, observed signals, or explicit uncertainty.

## Review checklist

Use these questions during code review, design review, and plan review:

- **TDD:** What failing test, characterization test, or executable check drove this change? If none, is the exception justified and what evidence replaced it?
- **Learning:** What did this change prove or disprove? Does it shorten or delay feedback?
- **Incrementality:** Can it ship or be validated in a smaller reversible slice?
- **Test quality:** Are tests fast, deterministic, meaningful, behavior-focused, maintainable, and suitable for CI?
- **Test level:** Is the behavior tested at the cheapest useful level, with integration/acceptance coverage for cross-boundary risk?
- **Deployability:** Does it preserve safe release, rollback, and recovery paths?
- **Modularity:** Are responsibilities isolated behind clear interfaces?
- **Cohesion:** Do the pieces that change together live together?
- **Coupling:** Does this introduce dependencies that make future changes expensive?
- **Information hiding:** Are internal details hidden, or are callers forced to know too much?
- **Stability:** What failure modes, reliability signals, or recovery paths changed?
- **Throughput:** Will this make future changes faster, slower, or safer?
- **Evidence:** Are claims backed by tests, commands, metrics, logs, artifacts, or concrete code evidence?

## Dynamic workflow guidance

For Pi Dynamic Workflows specifically:

- Use workflows to shorten learning loops when the work is broad, uncertain, or benefits from genuinely independent perspectives.
- Start workflow design from the test/feedback loop: what executable check or artifact will decide whether the workflow succeeded?
- Keep workflow branches independent, small, and evidence-producing. Each branch should return concrete artifacts, not just opinions.
- Persist artifacts so learning survives chat compaction: test output, failing cases, reproduction steps, synthesized decisions, rejected alternatives, and unresolved risks.
- Add synthesis-as-judge and adversarial review when correctness matters, but require executable tests or concrete evidence before accepting conclusions.
- Keep generated workflows small and task-specific until repeated evidence shows reusable value.
- Treat `maxAgents`, concurrency, model choice, stop conditions, and artifact paths as engineering controls. Set them from the learning goal, cost, risk, and verification strategy rather than copying defaults.
- Prefer one small workflow plus a fast check over a large orchestration that delays feedback or obscures responsibility.

## Anti-patterns to call out

- Implementing behavior before specifying the failing test or executable check.
- Treating TDD as optional when the task changes behavior without naming replacement evidence.
- Large speculative rewrites that postpone learning.
- Abstractions, configurability, or process added without evidence that they improve stability, throughput, or complexity control.
- Slow, flaky, overly integrated tests used where fast focused tests would work.
- Agent consensus, synthesis, or AI-generated code treated as equivalent to passing tests.
- Claims of success without commands, CI results, review evidence, metrics, or observable behavior.

## Guardrails

- Do not add bureaucracy, ceremonies, abstractions, or configurability unless they improve learning, stability, throughput, or complexity control.
- Do not optimize local speed by skipping tests or evidence.
- Do not confuse AI-generated output with correctness; require review and verification.
- If the best next step is a small test, spike, or measurement, prefer that over a grand design.
