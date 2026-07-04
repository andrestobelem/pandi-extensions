---
name: didactic-docs-style
description: >-
  Style contract for the didactic documentation of this repo (dynamic
  workflows guides, scaffold pages, primitives reference, READMEs). Use
  whenever writing, editing, reviewing, or generating documentation — by hand
  or via workflows like didactic-docs / scaffold-docs-html — so every doc
  opens in 30 seconds, discloses progressively, aids decisions with tables or
  mermaid, ships minimal runnable examples, and never trades accuracy for
  clarity.
---

# Didactic docs style contract

Goal: make each doc CLEARER and MORE DIDACTIC without losing one bit of
technical accuracy — clarity and correctness travel together, never traded
for one another. This contract is the single source of truth for the
"didactic" documentation standard of this repo; workflows that edit or
generate docs must load it and pass it to every editor/reviewer agent.

## The 8 rules

1. **30-second opening.** Start with 2-3 plain-language sentences: what this
   is, what problem it solves, when you'd reach for it. THEN a minimal
   runnable example, BEFORE any exhaustive reference.
2. **Progressive disclosure.** Order: quickstart → concepts → reference →
   advanced/edge cases. Never open with a wall of API details.
3. **Decision aids.** Where the reader must choose between alternatives
   (agents vs pipeline vs parallel vs race; run vs start; when to orchestrate
   at all), add a small decision table or a mermaid flowchart. Prefer one
   good table over three paragraphs.
4. **Minimal examples.** Every primitive/command gets a 3-8 line snippet that
   would actually run. Verify signatures and behavior against the extension
   source code — never invent.
5. **Accuracy is untouchable.** Every claim must be checkable in the code. If
   unsure, read the implementation. Keep every existing fact; you may
   reorder, reword, exemplify, and illustrate — not weaken or drop.
6. **Keep the document's existing language** (English docs stay English;
   Spanish docs stay Spanish).
7. **Keep it tight.** Didactic ≠ longer. Cut redundancy; primitives docs stay
   short (they ship in the npm package): target ≤ ~65 lines each.
8. **Markdown hygiene.** Valid GFM, sensible heading hierarchy, fenced code
   blocks with language tags, mermaid in ```mermaid fences. Must pass
   markdownlint defaults (no trailing spaces, single H1, blank lines around
   headings/lists/fences).

## Scaffold pages: required shape

Every `docs/scaffolds/<key>.md` page additionally follows this section order
(see any existing page, e.g. `docs/scaffolds/map-reduce.md`):

`# <key>` → blurb quote → **En 30 segundos** → **Cómo lanzarlo** (runnable
`/workflow` commands) → **Diagrama** (mermaid derived from the real code) →
**Qué hace** → **Cuándo usarlo** → **Cómo funciona** → **Input y output** →
**Fases**.

## How it is applied

- Generation: `.pi/workflows/scaffold-docs-html.js` writes the Markdown
  sources under `docs/scaffolds/` and runs `npm run sync:docs:html` (the
  `docs/html/` mirror is GENERATED — never hand-edit it).
- Improvement: `.pi/workflows/didactic-docs.js` edits docs in parallel under
  this contract, then runs an adversarial review panel (accuracy +
  didactics) → fixes → verification (markdownlint + HTML reconversion).
- Both workflows must read this file (`.pi/skills/didactic-docs-style/SKILL.md`)
  as the style contract, not an ad-hoc copy.
