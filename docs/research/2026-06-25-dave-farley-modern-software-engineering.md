# Software Engineering Principles According to Dave Farley

Date: 2026-06-25

## Context

Brief research on the software engineering principles Dave Farley presents in _Modern Software Engineering: Doing What Works to Build Better Software Faster_.

## Executive Summary

For Farley, modern software engineering is not more bureaucracy or heavier process. It is applying scientific, empirical, and pragmatic thinking to create better software faster.

The discipline is organized around two core competencies:

1. Being experts at learning.
2. Being experts at managing complexity.

## Main Principles

### 1. Optimize for learning

Software development is an activity of exploration, discovery, and design, not a production line. That is why Farley proposes:

- Work iteratively: move forward in short cycles to discover misunderstandings early.
- Seek fast, high-quality feedback: tests, continuous integration, user feedback, design review.
- Work incrementally: small, reversible, safe changes.
- Be experimental: formulate hypotheses, measure results, and control variables.
- Be empirical: decide based on evidence, not fashion, authority, or intuition.

### 2. Optimize for managing complexity

Because real systems cannot fit entirely in one person's head, engineering must control technical and organizational complexity. Farley highlights:

- Modularity: divide the system into understandable and modifiable parts.
- High cohesion: group together what changes for the same reasons.
- Separation of responsibilities: isolate distinct concerns.
- Information hiding and abstraction: expose simple interfaces and hide internal details.
- Low coupling: reduce dependencies that make the system costly to change.

### 3. Measure with useful criteria

Farley uses two dimensions aligned with _Accelerate_ as an evaluation yardstick:

- Stability: quality, reliability, low failure rate, and fast recovery.
- Throughput: the ability to deliver changes frequently and efficiently.

A practice, tool, or process should be adopted if it improves —or at least does not worsen— those two dimensions.

### 4. Tools in service of engineering

For Farley, the important tools are not only languages or frameworks, but practices that enable learning and complexity control:

- automated testing,
- TDD,
- continuous integration,
- continuous delivery,
- deployability,
- testability,
- small changes,
- fast pipelines.

## Condensed Thesis

Modern software engineering consists of applying practical science to development, optimizing the work system to learn quickly and control complexity, using evidence instead of faith, fashion, or intuition.

## Sources Consulted

- InformIT/Pearson: _Modern Software Engineering: Doing What Works to Build Better Software Faster_. https://www.informit.com/store/modern-software-engineering-doing-what-works-to-build-9780137314911
- InformIT/Pearson: sample chapter "Software Engineering Fundamentals". https://www.informit.com/articles/article.aspx?p=3129276
- Dave Farley: "What is Modern Software Engineering?". https://www.davefarley.net/?p=352
