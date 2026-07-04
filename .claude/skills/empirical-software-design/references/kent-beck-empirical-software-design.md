# Kent Beck empirical software design summary

Source research: four project research branches on Kent Beck (method-mechanics, decision-economics, pitfalls-criticisms, modern-ai-application), grounded in _Test-Driven Development: By Example_ (2002), _Tidy First?_ (2023), and Beck's newsletters.

## Canon TDD

Beck's definitive 2023 restatement: (1) write a test list of expected behavioral variants; (2) turn exactly one item into a concrete, runnable test; (3) make all tests pass, updating the list as you learn; (4) optionally refactor; (5) repeat until the list is empty. Step 4 is explicitly optional in the canon.

## Green-bar gears

From _TDD: By Example_ Part III (via chapter notes): Obvious Implementation (type the real code when clear and quick), Fake It (return a constant, then replace constants with variables), Triangulate (generalize only when two or more examples force it). Gears set step size: bigger when confident, smaller when a red bar surprises you.

## TCR

`test && commit || revert`: run tests after each tiny change; green commits, red reverts to the last passing state. Beck framed it as an experiment forcing smaller increments (Medium, 2018). Thoughtworks Radar rates it "Trial" — tiny steps, fast deterministic tests, risk tolerance. Whether Beck endorses TCR as ongoing practice: INSUFFICIENT_EVIDENCE.

## Tidy First? — structure vs. behavior

- Tidyings change structure, never behavior; keep them in separate commits/PRs, few per PR (ch. 16; ch. 28 "Reversible Structure Changes").
- Value = behavior today + options on future behavior; time value pushes toward shipping behavior now, optionality justifies structure investment (Part III).
- Coupling: one element changing necessitates changing another, relative to a particular likely change (ch. 29, paraphrase). Cohesion: put elements that change together, together (ch. 32).
- Timing (ch. 21; "First, After, Later, Never" post): First when it lowers the cost/risk of the immediate change or is needed to understand the code; After when you will touch the area again soon; Later when the payoff is real but deferrable and trackable; Never when the code will not change.
- Economic test (paraphrase via book notes): tidy first when cost(tidying) + cost(change after) < cost(change without). Exact DCF/option formulas: INSUFFICIENT_EVIDENCE.

## The 15 tidyings (Part I)

Guard Clauses; Dead Code; Normalize Symmetries; New Interface, Old Implementation; Reading Order; Cohesion Order; Move Declaration and Initialization Together; Explaining Variables; Explaining Constants; Explicit Parameters; Chunk Statements; Extract Helper; One Pile; Explaining Comments; Delete Redundant Comments (O'Reilly TOC).

## Four rules of simple design

Priority-ordered; sources disagree on the middle two. _XP Explained_ 1st ed. p. 57 (via Fowler): runs all the tests → no duplicated logic → states every intention → fewest classes/methods. Fowler's Beck-reviewed shorthand: passes the tests → reveals intention → no duplication → fewest elements. Rules 1 and 4 are stable. Verbatim wording: INSUFFICIENT_EVIDENCE.

## 3X: Explore / Expand / Extract

Explore (payoff unknown): many cheap, small, uncorrelated experiments; optimize learning; tolerate throwaway code. Expand: singular focus on the next growth bottleneck. Extract: optimize margin, reliability, repeatability via standardization and automation. Phases carry different tools and value systems and cannot safely be mixed. No sourced practice-by-phase mapping: INSUFFICIENT_EVIDENCE.

## Limits and misuse (Beck's own caveats)

- Confidence-based test depth (Stack Overflow, 2008, paraphrase): test as little as possible to reach a given confidence — more where mistakes are likely, less where a class of mistakes empirically does not occur.
- TDD value degrades with slow tests, failures with many possible causes, tests coupled to implementation, low-fidelity environments ("Is TDD Dead?", 2014).
- TDD does not make design decisions for you (paraphrase, "TDD Outcomes"). Misuse pattern: test-induced design damage — indirection added solely for test isolation; Beck's counter: blame the design judgment, not TDD (DHH 2014; Fowler's debate record).

## Augmented coding (2024–2025)

- AI shifts costs, not correctness; respond with many small experiments and fast feedback ("Exploring AI").
- Augmented ≠ vibe coding: the human still cares about complexity, tests, coverage, tidy design ("Beyond the Vibes").
- Tests as executable, binary agent guardrails; keep a large fast suite running constantly (Pragmatic Engineer interview, 2025).
- Persistent prompting rules: no code without a failing test; only enough code to pass; green before commit; never delete tests.
- Failure-mode watchlist ("Genie Wants to Leap"): loops, unrequested scope, deleted tests/assertions, fake implementations.
- Copy-from-simpler-language: implement in Python first, then have the agent translate tests plus code.
- Outcomes over orchestration ("Genie Lessons: Nobody Wants Agents").
- No primary source links TCR with agents: INSUFFICIENT_EVIDENCE.

## Quoting policy and gaps

Only licensed verbatim quote: Beck's 2012 tweet — "for each desired change, make the change easy (warning: this may be hard), then make the easy change." All book wording: paraphrase and attribute. The human/social side of design is thinly sourced (ch. 16 review economics; outcomes-over-orchestration); do not extrapolate beyond it.

## Sources

- https://tidyfirst.substack.com/p/canon-tdd
- https://medium.com/@kentbeck_7670/test-commit-revert-870bbd756864
- https://www.oreilly.com/library/view/tidy-first/9781098151232/
- https://newsletter.kentbeck.com/p/first-after-later-never
- https://newsletter.kentbeck.com/p/the-product-development-triathlon
- https://newsletter.kentbeck.com/p/exploring-ai
- https://tidyfirst.substack.com/p/augmented-coding-beyond-the-vibes
- https://newsletter.kentbeck.com/p/genie-wants-to-leap
- https://newsletter.kentbeck.com/p/persistent-prompting
- https://newsletter.kentbeck.com/p/augmented-coding-technique-copy-from
- https://tidyfirst.substack.com/p/genie-lessons-nobody-wants-agents
- https://newsletter.kentbeck.com/p/tdd-outcomes
- https://newsletter.pragmaticengineer.com/p/tdd-ai-agents-and-coding-with-kent
- https://martinfowler.com/bliki/BeckDesignRules.html
- https://martinfowler.com/articles/is-tdd-dead/
- https://stanislaw.github.io/2016-01-25-notes-on-test-driven-development-by-example-by-kent-beck.html
- https://danlebrero.com/2024/08/07/tidy-first-summary/
- https://guidefari.com/tidy-first/
- https://www.thoughtworks.com/en-us/radar/techniques/tcr-test-commit-revert
- https://stackoverflow.com/questions/153234/how-deep-are-your-unit-tests/153565#153565
- https://dhh.dk/2014/test-induced-design-damage.html
- https://x.com/KentBeck/status/250733358307500032
