---
name: empirical-software-design
description: >-
  Apply Kent Beck-style empirical software design when driving the fine-grained
  TDD rhythm (test list, fake it, triangulate, step-size gears), separating
  structure changes from behavior changes, timing tidying as
  first/after/later/never by local economics, applying the four rules of simple
  design, matching practices to explore/expand/extract phases, or supervising
  an AI coding agent with Beck's augmented-coding guardrails. Use to size the
  next step, decide when tidying pays for itself, and keep design choices
  grounded in feedback and reversibility.
---

# Empirical Software Design

Reach for this skill for fine-grained design judgment inside the coding loop: sizing the next TDD step, deciding whether to tidy before, after, later, or never, separating structure from behavior, judging how simple is simple enough, or keeping an AI coding agent inside a tight feedback loop.

This skill is based on the project research distilled from Kent Beck's _Test-Driven Development: By Example_, _Tidy First?_, Canon TDD, the 3X model, and his augmented-coding writing. See `references/kent-beck-empirical-software-design.md` for the compact source summary.

It supplies Beck's micro-rhythm and design economics inside the loops the other lens skills define. `modern-software-engineering` owns TDD as this repo's default feedback loop and the required response shape — defer to it for whether and when TDD applies; this skill governs step size and design moves inside that loop. `ai-assisted-engineering` owns the AI-delegation decision and prototype-vs-production stakes; this skill only adds Beck's practice patterns once delegation is decided.

## Core lens

1. **Software value = behavior today + options on future behavior.** Behavior changes deliver value now (money now beats money later); structure changes buy options on future changes (_Tidy First?_ Part III).
2. **Structure and behavior are different economic goods.** Never mix them in one change; keep tidyings in separate commits/PRs with as few tidyings per PR as possible, so each is cheap for humans to review and cheap to reverse (_Tidy First?_ ch. 16, 28).
3. **Coupling is the cost driver.** Coupling is relative to a particular likely change — one element changing necessitates changing another (ch. 29, paraphrase). Cohesion: put elements that change together, together (ch. 32). Tidying pays when it reduces coupling on paths you actually change.
4. **Step size is a dial, not a dogma.** Prefer the smallest step that produces verifiable feedback; shift smaller when surprised, larger when confident.
5. **Design timing is a local economic choice, not a cleanliness ideal.** "Later" and "never" are legitimate answers.
6. **AI shifts costs, not correctness.** Cheap experiments become abundant; correctness still comes from small inspectable feedback loops ("Exploring AI", 2024).

## The micro-rhythm (Canon TDD)

For a behavior change driven test-first, use Beck's Canon TDD steps:

1. **Write a test list** of the expected behavioral variants before coding.
2. **Turn exactly one item into a concrete, runnable, failing test.**
3. **Make all tests pass**, updating the list as you learn. Pick a green-bar gear: **Obvious Implementation** (type the real code when it is clear and quick), **Fake It** (return a constant, then replace constants with variables), or **Triangulate** (generalize only when two or more examples force it). Downshift whenever a red bar surprises you.
4. **Optionally refactor.** Canon TDD marks this step optional; this repo's default loop (Farley lane) requires narrating the Refactor decision — follow the repo rule, and use the tidyings and four rules below for what to do inside it.
5. **Repeat until the test list is empty.**

Calibrate test depth by confidence, not coverage ritual: test more where mistakes are likely (complicated conditionals, known team failure patterns), less where a class of mistakes empirically does not occur (Beck's Stack Overflow answer, 2008, paraphrase).

**TCR (`test && commit || revert`)** is the extreme end of the step-size dial: green commits, red reverts to the last passing state. Beck framed it as an experiment that forces smaller increments (2018); Thoughtworks Radar rates it "Trial". Use it only as a deliberate step-size experiment with tiny steps and fast deterministic tests — never as a default, and not bundled with agent automation (no sourced link between the two).

## Structure vs. behavior: tidyings and timing

1. **Classify every change first:** structure (tidying) or behavior. One kind per commit/PR.
2. **Pick tidyings from Beck's catalog** of 15 small behavior-preserving moves (guard clauses, dead code, explaining variables, extract helper, reading order, and so on — full list in the references file).
3. **Time the tidying — first, after, later, or never:**
   - **First** when it lowers the cost or risk of the immediate behavior change, or you need it to understand the code.
   - **After** when you will touch the same area again soon.
   - **Later** when the payoff is real but deferrable and the team can track the deferred work.
   - **Never** when the code will not change again.
4. **Apply the economic test** (paraphrase of ch. 21): tidy first when cost(tidying) + cost(change after tidying) < cost(change without tidying).
5. **Preparatory-change rule** — Beck's 2012 tweet: "for each desired change, make the change easy (warning: this may be hard), then make the easy change."

## Four rules of simple design

Use as the tie-breaker during refactoring, in priority order:

- **Rule 1 (stable): passes all the tests.**
- **Rules 2–3: reveals intention / has no duplicated logic.** Beck's own tellings disagree on which comes second (Fowler's Beck-reviewed shorthand vs. _XP Explained_ 1st ed. p. 57 swap them); name the source if the middle order matters. Do not present one middle ordering as canonical.
- **Rule 4 (stable): fewest possible elements** (classes and methods).

## Explore / Expand / Extract

Match practice to phase; each phase has different tools and value systems that cannot safely be mixed:

- **Explore** (payoff unknown): many cheap, small, uncorrelated experiments; optimize learning speed; tolerate throwaway code.
- **Expand** (growth found): singular focus on the next bottleneck to growth.
- **Extract** (value known): optimize margin, reliability, and repeatability via standardization and automation.

Beck publishes no practice-by-phase table — derive practice choices from the phase's goal rather than inventing a canned mapping.

## Augmented-coding practice patterns

Once the delegation decision is made (see `ai-assisted-engineering`), apply Beck's patterns for working with an AI "genie":

1. **Augmented, not vibe:** keep caring about complexity, tests, coverage, and tidy design even when the AI types; the human retains design responsibility.
2. **Persistent prompt guardrails:** recurring rules such as no code without a failing test, only enough code to pass, green before commit, never delete tests.
3. **Failure-mode watchlist as hard stops:** loops, unrequested scope, deleted tests or assertions, fake implementations.
4. **Keep a large fast test suite running constantly** to catch regressions as they happen.
5. **Reduce problem complexity first:** for example, implement in a simpler language, then have the agent translate tests plus code (copy-from-simpler-language).
6. **Optimize for outcomes, not orchestration:** developers want results, not agent-swarm management for its own sake ("Genie Lessons").

## Required response shape when using this skill

For coding, refactoring, or review guidance, include these unless clearly irrelevant:

- **Change classification:** structure or behavior — and how the commits keep them separate.
- **Test list:** the behavioral variants to cover, taken one at a time.
- **Step-size gear:** obvious implementation, fake it, or triangulate — and the downshift trigger.
- **Tidy timing:** first/after/later/never, with the local economic reason.
- **Simplicity check:** the four rules (with the ordering caveat when the middle order matters).
- **Reversibility:** how this step stays cheap to review and revert.

## How to apply it

1. Classify the change (structure vs. behavior) before touching code.
2. Write the test list; pick exactly one item.
3. Pick the smallest gear that produces verifiable feedback; downshift on surprise.
4. Decide tidy timing economically; when tidying first, justify it with the preparatory-change rule.
5. Refactor against the four rules; stop at fewest elements — do not gold-plate.
6. Keep every step reversible: separate commits, few tidyings per PR, green between steps.
7. Before mandating the micro-rhythm, check Beck's own degradation conditions: slow tests, failures with many possible causes, tests coupled to implementation, low-fidelity test environments ("Is TDD Dead?", 2014).

## Review checklist

- Does any commit mix structure and behavior changes?
- Did a test list precede the code, and did each test arrive one at a time?
- Was generalization triangulated from at least two examples, or guessed from one?
- Is tidy timing stated (first/after/later/never) with an economic reason, or driven by cleanliness ideals?
- Does the refactor stop at the four rules, or add elements beyond the fewest needed?
- Is test depth justified by confidence, or by a fixed coverage percentage?
- Are indirections (mocks, adapters, layers) motivated by design, or only by test-isolation speed (test-induced design damage)?
- For agent-produced diffs: any deleted or weakened assertions, fake implementations, unrequested scope, or loops?

## Dynamic workflow guidance

For Pi Dynamic Workflows specifically:

- In Explore-phase work, prefer many cheap, small, uncorrelated branches over one big orchestration; optimize the workflow for learning speed.
- Give implementing subagents the micro-rhythm as their contract: test list first, one test at a time, structure/behavior separation in the diffs they return.
- Encode Beck's persistent-prompt guardrails in worker prompts (no code without a failing test; never delete tests) and treat the failure-mode watchlist as branch-level stop conditions.
- Persist the test list, gear choices, and tidy-timing decisions as artifacts so the design reasoning survives compaction.
- Judge the workflow by outcomes, not by how much agent orchestration it exercises.

## Anti-patterns to call out

- Mixing tidyings and behavior changes in one commit or PR.
- Tidying driven by cleanliness ideals — never asking whether "later" or "never" is the right answer.
- Generalizing from a single example instead of triangulating.
- Test-induced design damage: adding indirection solely to get fast isolated tests; Beck's counter — blame the design judgment, not TDD.
- Fixed coverage targets in place of confidence-based test depth.
- Presenting TCR as a default practice, or running it on slow or flaky tests.
- Accepting agent output that deletes or weakens tests, fakes implementations, or expands scope unasked.
- Quoting the four rules with one fixed middle ordering as if canonical.

## Guardrails

- Paraphrase Beck's book wording; the only licensed verbatim quote is the 2012 preparatory-change tweet.
- Check the TDD degradation conditions before prescribing the micro-rhythm; if they hold, fix the feedback (test speed, determinism, fidelity) first.
- Do not mix 3X phase value systems; name the phase before choosing practices.
- Do not present TCR as Beck's recommended default, and do not combine TCR with agent automation as one practice — the research sources them only separately.
- Defer whether TDD applies at all, and the repo response shape, to `modern-software-engineering`; defer the AI-delegation decision to `ai-assisted-engineering`.
- The human/social side here is limited to what is sourced: small separate PRs keep review cheap for people, and outcome-orientation beats agent-swarm management. Do not extrapolate a broader social method from it.
