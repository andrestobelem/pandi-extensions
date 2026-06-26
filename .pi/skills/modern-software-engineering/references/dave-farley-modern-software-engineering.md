# Dave Farley modern software engineering summary

Source research:
- `docs/research/2026-06-25-dave-farley-modern-software-engineering.md`
- InformIT/Pearson: _Modern Software Engineering: Doing What Works to Build Better Software Faster_
- InformIT/Pearson sample chapter “Software Engineering Fundamentals”
- Dave Farley: “What is Modern Software Engineering?”

## Thesis

Modern software engineering is not heavier process. It is the disciplined use of scientific, empirical, and pragmatic thinking to build better software faster.

## Two core competencies

1. **Learning:** software development is discovery and design. Work iteratively and incrementally, seek fast high-quality feedback, formulate hypotheses, measure results, and decide from evidence.
2. **Managing complexity:** real systems cannot fit in one person’s head. Use design principles that keep systems understandable and changeable.

## Complexity/design principles

- **Modularity:** split the system into understandable, modifiable parts.
- **High cohesion:** keep things together when they change for the same reason.
- **Separation of concerns:** isolate distinct responsibilities.
- **Information hiding and abstraction:** expose simple interfaces and hide internal details.
- **Low coupling:** reduce dependencies that make change expensive.

## Evaluation criteria

Farley’s useful yardstick aligns with _Accelerate_:

- **Stability:** quality, reliability, low failure rate, and fast recovery.
- **Throughput:** frequent and efficient delivery of changes.

Adopt a practice, tool, or process when it improves one of these dimensions without materially damaging the other.

## Practices that serve the principles

- automated testing
- TDD
- continuous integration
- continuous delivery
- deployability
- testability
- small changes
- fast pipelines

## TDD as executable learning

In this skill, TDD is treated as the default concrete loop for behavior-changing work because it turns learning into executable feedback:

1. **Red:** capture the desired behavior, bug, or characterization as a failing test/check.
2. **Green:** make the smallest change that passes.
3. **Refactor:** improve design while preserving green tests.

TDD should not become ceremony. If the work is docs-only, exploratory research, a throwaway spike, or runtime/operational diagnosis, use another fast evidence loop and state it explicitly.

## Practical prompt to apply

For any proposed change, ask:

1. What are we trying to learn?
2. What is the smallest safe step?
3. What feedback will prove or disprove it?
4. Does this reduce or increase complexity?
5. What is the effect on stability and throughput?
