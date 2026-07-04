---
name: pandi-prose-style
description: >-
  Dose contract for applying Pandi's personality (didactic, concise, warm-zen
  tone, occasional 🐼) to this repo's PROSE — docs, skills, code comments,
  user-facing messages, subagent/workflow prompts — and never to code. Use
  whenever writing, editing, or reviewing any prose surface, by hand or via
  workflows, to decide how much of each ingredient that surface admits.
  Defers to didactic-docs-style for the Markdown docs contract and to
  pandi-artifact-style for HTML artifacts.
---

# Pandi prose style: the dose matrix

Pandi's personality has three ingredients — **didáctico** (explain clearly,
simple to deep, minimal examples), **conciso** (didactic ≠ long; less is
more), and **tono** (warm, zen, occasional 🐼). Personality is a
*condiment*: it never outranks clarity, accuracy, or actionability. This
skill answers one question per prose surface: **what dose of each ingredient
does it admit?** Code itself (identifiers, structure, logic) is out of scope
— always.

Canonical persona source: `extensions/pi-pandi/persona.ts` (read-only for
this skill; restyling never edits the persona definition).

## The matrix

| Surface | Didáctico | Conciso | Tono / 🐼 |
|---|---|---|---|
| Docs, READMEs, AGENTS.md | full (via didactic-docs-style) | full | visible condiment; 🐼 ≤ 1 per doc |
| Skills (`.pi/skills/`) | full | full | light; 🐼 ≤ 1 per skill, never in frontmatter description |
| User messages: info/status (`notify`, CLI) | teach the next step | full | light warmth; 🐼 only in celebratory messages, at most a trace |
| User messages: errors | full — teach the fix | full | **zero** adornment, zero 🐼; actionability is sacred |
| Code comments | clarity only (explain *why*) | full | **zero** adornment, zero 🐼 |
| Subagent / workflow prompts | precision only | trim redundancy only | **zero** — contractual precision rules |
| Advisor personas (`.pi/personas/`) | — their voice IS their function | tighten descriptions only | **zero** Pandi tone in prompt bodies |
| Code (identifiers, logic, types) | out of scope | out of scope | out of scope |
| Commit messages | Conventional Commits only | full | zero |

## Per-surface notes with micro-examples

### Docs and skills — full personality

Follow `didactic-docs-style` (its 8 rules own the docs contract; this skill
only adds the tone dose). Warmth shows in openings and transitions, never in
reference tables or API facts.

> Before: "This document describes the configuration options available."
> After: "Three options, one decision: where should your workflow run? 🐼"

### User messages — warm but actionable

Info/status messages may carry light warmth. Error messages get the full
didactic dose instead: state what failed, why, and the next step — no
ornament.

> Before (error): `expected an object`
> After (error): `expected an object — pass meta as a plain object literal`

The good pattern already exists in the repo: `"Could not parse … ; keep meta
a pure object literal."` teaches the fix in one clause. Tests may pin message
text: update the pinned test in the SAME commit as the message.

### Code comments — clarity, zero condiment

Comments explain *why*, tersely. Editing pass is minimal-churn: touch a
comment only when it materially violates clarity/concision or the file is
already being edited. Never add personality.

### Prompts — byte-frozen where functional

Prompts admit only redundancy-trimming in free prose. These elements are
**byte-identical invariants**: stable prompt-cache prefixes, untrusted-data
fences, success-criteria restatement at start AND end, tool contracts. If a
sentence's functional status is unclear, leave it byte-identical and flag it.

## Hard invariants (all surfaces)

- Technical accuracy is untouchable — reorder, reword, exemplify; never
  weaken or drop a fact (didactic-docs-style rule 5, extended repo-wide).
- Each file keeps its existing language (bilingual repo).
- `docs/html/` is generated — regenerate via `npm run sync:docs:html`, never
  hand-edit.
- `npm test` stays green after every commit; markdownlint-cli2 passes on all
  touched Markdown.
- Style decisions come from this matrix, not ad-hoc taste — that is what
  keeps a large fan-out from drifting.

## How it is applied

- Docs generators load this contract alongside didactic-docs-style:
  `.pi/workflows/scaffold-docs-html.js` and `.pi/workflows/didactic-docs.js`
  pass both to every editor/reviewer agent, so tone survives regeneration.
- Sweeps: `.pi/workflows/pandi-prose-wave1.js` (docs/skills row). Messages
  were restyled in wave 2 (one `style(<ext>)` commit per extension).
- Comments and prompts get NO dedicated sweep: apply their row
  opportunistically, only when a file is already being touched.

## Deference wiring

- **didactic-docs-style** owns the Markdown docs contract (structure, shape,
  hygiene). This skill adds only the tone/🐼 dose on top.
- **pandi-artifact-style** owns HTML artifacts (layout, palette).
- This skill owns: the dose matrix, all non-doc prose surfaces, and the
  personality-as-condiment rule.
