---
name: clean-craftsmanship
description: >-
  Apply Robert C. Martin ("Uncle Bob")-style clean craftsmanship when writing
  or reviewing code for readability (naming, functions, comments), diagnosing
  design rot with SOLID and component principles, checking Clean Architecture
  boundaries and the Dependency Rule, or exercising professionalism
  disciplines (three laws of TDD as discipline, saying no, honest estimates,
  Boy Scout cleanup). Use when the question is code-level craft, dependency
  direction, whether a boundary earns its cost, or professional conduct under
  schedule pressure.
---

# Clean Craftsmanship

Use this skill when a task calls for code-level craft or professional judgment: naming and function structure, comment policy, spotting design rot, checking dependency direction, deciding whether an interface or layer earns its cost, or handling estimates, commitments, and schedule pressure honestly.

This skill is based on the project research distilled from Robert C. Martin's Clean Coder blog, the 2000 paper "Design Principles and Design Patterns", *Clean Code* (ch. 1–3), and *The Clean Coder*, plus documented criticism and Martin's own responses to it. See `references/uncle-bob-clean-craftsmanship.md` for the compact source summary.

This skill owns Martin's code-level craft, design diagnostics, and professionalism disciplines. `modern-software-engineering` owns TDD as this repo's default feedback loop and the required response shape — defer to it for whether and when TDD applies. `empirical-software-design` owns the fine-grained TDD rhythm and the tidy first/after/later/never timing economics — the Boy Scout rule here covers only in-passing cleanup and defers that bet to it. `ai-assisted-engineering` owns the AI-delegation decision; this skill only adds Martin's tests-green-before-AI-refactor gate.

## Core lens

1. **Going well is the only way to go fast.** Messy code raises the cost of every later change, feeding a loop of slower delivery, schedule pressure, and more mess ("Going Fast", 2007; *Clean Code* ch. 1). Craftsmanship is refusing to do poor work or make messes to meet a schedule (2011).
2. **Discipline removes discretion.** Each rule constrains what you may do next at a specific timescale, making quality the default rather than an act of will — the three laws of TDD force testable, decoupled design as a side effect.
3. **Rot has exactly four symptoms, all traced to unmanaged dependencies.** Rigidity, fragility, immobility, and viscosity (design and environment) are the diagnosis; SOLID and the component principles are the treatment (2000 paper).
4. **Source-code dependencies point inward.** That is the one architecture invariant; the concentric-circle diagram is schematic, not a mandatory layer count (Martin, 2012).
5. **A mess is not technical debt.** Debt can be a deliberate, reasoned trade-off repaid with discipline; a mess is pure loss with no upside ("A Mess is not a Technical Debt").
6. **Professionals communicate honestly.** An estimate is a probability distribution; a commitment is a promise; saying "I'll try" under pressure is a covert implied commitment (*The Clean Coder*).

## The disciplines

1. **Three laws of TDD, as professional constraint.** Paraphrased (verbatim wording is unverified in the research — never quote): write production code only to make a failing test pass; write no more of a test than suffices to fail, compilation failures counting; write no more production code than suffices to pass the one failing test. Martin nests these as the nano-cycle inside Red–Green–Refactor ("The Cycles of TDD", 2014). Whether TDD is the loop for this change is Farley's call; step size and design moves inside the loop are Beck's; this lane contributes the laws as discipline.
2. **Green-bar step selection (Transformation Priority Premise).** When making a test pass, prefer the simplest code transformation from Martin's ordered list (constant before scalar, if before while, recursion late); if a test forces a low-priority transformation, consider a different test (TPP posts, 2013).
3. **Readability craft.** Functions: small; do one thing; one level of abstraction per function; the stepdown rule (code reads top-down); few arguments; no side effects; command–query separation; exceptions over error codes; DRY (*Clean Code* ch. 3). Names carry intent; Martin treats a comment as a failure to express intent in code (documented in the Ousterhout–Martin debate), so try renaming/extracting before annotating.
4. **Boy Scout rule — in-passing cleanup only.** Check a module in a little cleaner than you found it (*97 Things* ch. 8; *Clean Code* ch. 1), keeping cleanup continuous and amortized. Scope it to small opportunistic improvements inside the change you are already making; any larger tidy-first/after/later/never bet defers to `empirical-software-design`.
5. **Diagnose rot before prescribing principles.** Look for the four symptoms with concrete evidence, trace them to dependencies, and apply SOLID and component principles where symptoms appear — not everywhere preemptively (2000 paper; defended in "Solid Relevance", 2020). No canonical priority ordering among the SOLID principles is sourced; do not rank them.
6. **Dependency Rule and boundaries.** Keep source dependencies pointing inward; cross boundaries via interfaces owned by the inner side (Dependency Inversion). Good architecture keeps framework, database, and UI choices cheap to change by treating them as details at the edges (2011, 2012 posts).
7. **Professional conduct.** Say no rather than "I'll try"; separate estimates from commitments; quantify uncertainty with PERT trivariate estimates, mean (O + 4N + P) / 6 and spread (P − O) / 6 (*The Clean Coder* ch. 10); accept debt only deliberately, visibly, and with a repayment plan — never as a mess.

## Required response shape when using this skill

For craft reviews, design diagnostics, or professionalism calls, include these unless clearly irrelevant:

- **Readability verdict:** whether names, functions, and structure state intent, with the specific rule violated (e.g. mixed abstraction levels, side effects).
- **Rot symptoms:** which of the four are observed, each tied to code evidence and the dependency causing it.
- **Dependency direction:** where source dependencies point at each boundary touched, and any inward-rule violations.
- **Boundary justification:** what pays for each interface/layer (second implementation, adapter volatility, domain complexity) — or a recommendation to remove it.
- **Honest commitment status:** whether the answer given is an estimate (with uncertainty) or a commitment, and no "I'll try".
- **Cleanup scope:** what in-passing Boy Scout cleanup rides along; anything bigger named and deferred to the Beck skill's timing decision.

## How to apply it

1. **Read for intent first.** Can you follow the code top-down without jumping? Fix names and extraction before anything structural.
2. **Diagnose before prescribing.** Name the rot symptom and the unmanaged dependency behind it; only then reach for a principle or pattern.
3. **Check direction at every boundary.** Inner code must not name or know outer code; cross with inner-owned interfaces.
4. **Make each abstraction pay rent.** Justify every interface or layer with a concrete force; delete speculative ones.
5. **Clean in passing.** Leave touched modules slightly cleaner; keep the cleanup inside the current change's blast radius.
6. **Keep communication honest.** Give ranges, not promises; escalate impossible asks with a "no" plus alternatives instead of silent heroics.
7. **Gate AI refactoring on green tests.** Martin's sourced AI practice (Duffield interview, 2024): hand code to AI for refactoring only after all tests pass, and accept the result only on human judgment. Whether to delegate at all is `ai-assisted-engineering`'s call.

## Review checklist

- **Names:** Do they reveal intent, or does the reader need a comment or the implementation?
- **Functions:** Small, one thing, one abstraction level, few arguments, no hidden side effects, command–query separated?
- **Comments:** Is each comment doing work code cannot, or compensating for expressible intent?
- **Duplication:** Any knowledge repeated that should live in one place?
- **Rigidity:** Do small changes cascade through dependent modules?
- **Fragility:** Do changes break conceptually unrelated places?
- **Immobility:** Is reusable logic trapped by entangled dependencies?
- **Viscosity:** Is the design-preserving change harder than the hack — or is the environment (slow builds/tests) pushing shortcuts?
- **Direction:** Do all source dependencies point inward across the boundaries touched?
- **Boundary rent:** Does each interface/layer have a second implementation, volatile adapter, or domain complexity paying for it?
- **Discipline:** Did a failing test precede the production code (three laws)? Loop-default questions go to `modern-software-engineering`.
- **Honesty:** Are estimates distributions, commitments explicit, and messes never labelled "debt"?

## Dynamic workflow guidance

For Pi Dynamic Workflows specifically:

- Give reviewer personas the four rot symptoms as structured probes; require each claimed symptom to come with file/line evidence and the offending dependency, not adjectives.
- Dependency direction is machine-checkable: prefer executable checks (dependency lints, build-time architecture tests) over subagent opinion. Encoding such rules as agent guardrails in instruction files plus CI checks is a practitioner adaptation (NimblePros and others), not Martin's own method — attribute it as such.
- Prompts alone are weak enforcement: research found LLM-generated code with higher code-smell incidence than human baselines, so verify craft claims in CI/review, not by generation.
- Apply saying-no to workflow scoping: when a requested scope is impossible within budget, report that with alternatives instead of "trying" and under-delivering.
- Run AI-refactor branches only against suites that are already green, and require human-judged acceptance of the diff.

## Anti-patterns to call out

- Cargo-cult layering: mandatory four-layer stacks, one-implementation interfaces, or use-case/DTO ceremony on a thin CRUD feature (a documented case: a two-screen app split into 22 modules). Martin's own post says the circles are schematic.
- Ranking SOLID principles or applying them as unconditional rules without observed rot symptoms.
- Saying "I'll try" under pressure — a covert, dishonest commitment.
- Presenting a mess as "technical debt" to legitimize it.
- Comments papering over names and functions that could express the intent directly.
- Boy Scout cleanup ballooning into an unplanned rewrite inside an unrelated change.
- Accepting AI-refactored code without a green suite before and human judgment after.

## Guardrails

- Carry Martin's own scope caveat: these rules trade CPU cycles for programmer cycles and may not fit GPU, inner-loop, or performance-critical code (his concession in the Muratori Q&A). Late binding earns its cost chiefly at plugin/library boundaries.
- The only architecture invariant is inward-pointing source dependencies; do not demand a fixed layer count. Introduce interfaces/layers only when a second implementation, adapter volatility, or domain complexity pays for them (critics' corrective heuristic, consistent with Martin's schematic caveat).
- Paraphrase the three laws with attribution; the canonical page's verbatim wording was not verified in the research.
- The acceptance-test/"QA should find nothing" discipline ("repeatable proof") is commonly attributed to *The Clean Coder* but was not verified in the source research — do not assert it. What is sourced: Martin frames TDD as playing a significant role in professional behavior without making it the sole admissible discipline ("Professionalism and TDD (Reprise)", 2014).
- The *Clean Craftsmanship* (2021) book's internal structure was not directly sourced; this skill grounds in the blog posts, the 2000 paper, *Clean Code* ch. 1–3, and *The Clean Coder*.
- Defer lanes explicitly: TDD-as-default-loop and the repo response shape → `modern-software-engineering`; micro-rhythm, tidyings, and tidy-timing economics → `empirical-software-design`; the AI-delegation decision → `ai-assisted-engineering`.
