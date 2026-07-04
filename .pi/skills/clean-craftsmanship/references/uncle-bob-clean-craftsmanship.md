# Robert C. Martin clean craftsmanship summary

Source research: four project research branches on Robert C. Martin (method-mechanics, decision-economics, pitfalls-criticisms, modern-ai-application), drawing on his Clean Coder blog, the 2000 paper "Design Principles and Design Patterns", *Clean Code*, *The Clean Coder*, and 2023–24 interviews.

## Thesis

Cleanliness is speed: messy code raises the cost of every later change, creating a loop of slower delivery, schedule pressure, and more mess — going well is the only way to go fast (paraphrase; "Going Fast", 2007; *Clean Code* ch. 1). Craftsmanship means refusing to do poor work or make messes to meet a schedule (2011 post). The disciplines act as constraints that remove discretion at specific timescales.

## TDD as discipline

- Three laws (paraphrase; canonical page returned 502 during research, verbatim wording unverified): (1) no production code except to pass a failing test; (2) no more test than suffices to fail — compilation counts; (3) no more production code than suffices to pass (butunclebob.com; "The Cycles of TDD", 2014).
- Cycle hierarchy: nano (three laws, seconds) → micro (Red/Green/Refactor, minutes) → milli (specific tests, generic code, ~10 min) → primary (architecture check, hours) (2014).
- Transformation Priority Premise (2013): ordered list of transformations; prefer the simpler; if a test forces a low transformation, pick a different test.

## Code-level rules

- *Clean Code* ch. 3 function rules (headings): small; do one thing; one level of abstraction per function; the stepdown rule; function arguments; no side effects; command–query separation; exceptions over error codes; DRY.
- Comments: Martin treats comments as failures to express intent in code (position documented in the Ousterhout–Martin debate repo).
- Boy Scout rule: check a module in cleaner than checked out (*97 Things* ch. 8); leave the campground cleaner (*Clean Code* ch. 1, p. 14). Makes cleanup continuous and amortized.

## Design diagnostics

- Four rot symptoms — rigidity (changes cascade), fragility (unrelated breakage), immobility (code cannot be reused), viscosity (hacks easier than design-preserving changes; includes environment viscosity) — all traced to unmanaged dependencies; SOLID-family plus component principles are the treatment, applied where symptoms appear (2000 paper). Continued defense in "Solid Relevance" (2020). No canonical priority ordering among SOLID principles is sourced.

## Architecture

- Dependency Rule (paraphrase, 2012): source-code dependencies point only inward; inner circles know nothing of outer circles; cross boundaries via inner-owned interfaces. The circles are schematic — inward dependencies are the only invariant, four layers are not mandatory (same post).
- Good architecture keeps framework/DB/UI decisions cheap to defer as details at the edges ("Clean Architecture", 2011).

## Professionalism

- Say no rather than "I'll try"; "try" is a covert implied commitment ("Saying No"; InformIT interview).
- Estimates are probability distributions, commitments are promises; PERT trivariate: mean (O + 4N + P) / 6, spread (P − O) / 6 (*The Clean Coder* ch. 10; formulas cross-verified via secondary summaries, exact book wording not directly quoted).
- Mess ≠ debt: debt can be a deliberate, repaid trade-off; a mess is pure loss ("A Mess is not a Technical Debt").
- TDD plays a significant role in professional behavior without being the sole admissible discipline ("Professionalism and TDD (Reprise)", 2014). Repeatable proof / acceptance-test ("QA should find nothing") discipline: INSUFFICIENT_EVIDENCE in this research — not asserted. *Clean Craftsmanship* (2021) book structure: not directly sourced.

## Scope caveats and criticism

- Martin's concessions (Muratori Q&A): the performance analysis is essentially correct at the nanosecond level; Clean Code trades programmer cycles for CPU cycles; may not fit GPU/inner-loop work; late binding earns its cost mainly at plugin/library boundaries.
- qntm: the book's own examples often contradict its advice. North (CUPID): per-letter SOLID critique, properties over principles. Ousterhout–Martin debate: documented disagreement on method length, comments, TDD.
- Cargo-cult evidence: a two-screen app built "by the book" yielded 22 modules (Korolev). Corrective heuristic (Rentea; Ardalis): introduce interfaces/layers only when a second implementation, adapter volatility, or domain complexity pays for them.

## AI-era application

- Duffield interview (2024, paraphrase): Martin uses AI mostly as Q&A/API help; asks AI to refactor only after all tests pass; accepts results only on his own judgment; expects AI to create more programming work, not eliminate programmers.
- Practitioner adaptation, not Martin's writing: encoding the Dependency Rule/SOLID as agent guardrails in instruction files plus build-time architecture tests (NimblePros), motivated by higher code-smell incidence in LLM-generated Java (arXiv 2025).

## Sources

- https://butunclebob.com/ArticleS.UncleBob.TheThreeRulesOfTdd
- https://blog.cleancoder.com/uncle-bob/2014/12/17/TheCyclesOfTDD.html
- https://blog.cleancoder.com/uncle-bob/2013/05/27/TheTransformationPriorityPremise.html
- https://blog.cleancoder.com/uncle-bob/2012/08/13/the-clean-architecture.html
- https://blog.cleancoder.com/uncle-bob/2011/11/22/Clean-Architecture.html
- https://www.fil.univ-lille.fr/~routier/enseignement/licence/coo/cours/Principles_and_Patterns.pdf
- https://www.oreilly.com/library/view/clean-code-a/9780136083238/chapter03.xhtml
- https://www.oreilly.com/library/view/97-things-every/9780596809515/ch08.html
- https://www.informit.com/articles/article.aspx?p=1235624&seqNum=3
- https://www.informit.com/articles/article.aspx?p=1235624&seqNum=6
- https://sites.google.com/site/unclebobconsultingllc/going-fast
- https://sites.google.com/site/unclebobconsultingllc/a-mess-is-not-a-technical-debt
- https://sites.google.com/site/unclebobconsultingllc/blogs-by-robert-martin/saying-no
- https://www.informit.com/articles/article.aspx?p=1711821
- https://www.oreilly.com/library/view/clean-coder-the/9780132542913/ch10.xhtml
- https://blog.cleancoder.com/uncle-bob/2020/10/18/Solid-Relevance.html
- https://blog.cleancoder.com/uncle-bob/2014/05/02/ProfessionalismAndTDD.html
- https://blog.cleancoder.com/uncle-bob/2011/01/17/software-craftsmanship-is-about.html
- https://github.com/unclebob/cmuratori-discussion/blob/main/cleancodeqa.md
- https://qntm.org/clean
- https://dannorth.net/blog/cupid-for-joyful-coding/
- https://github.com/johnousterhout/aposd-vs-clean-code
- https://victorrentea.ro/blog/overengineering-in-onion-hexagonal-architectures/
- https://ardalis.com/clean-architecture-sucks/
- https://pavelkorolev.xyz/blog/2023-08-23-clean-architecture-android/
- https://jesseduffield.com/Bob-Martin-Interview/
- https://blog.nimblepros.com/blogs/ai-agents-clean-architecture/
- https://arxiv.org/html/2510.03029v1
