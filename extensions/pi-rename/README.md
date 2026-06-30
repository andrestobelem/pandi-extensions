# pi-dynamic-workflows-rename

Individual Pi package for the `/rename` extension.

## Install

From this repository:

```bash
pi install ./extensions/pi-rename
pi install -l ./extensions/pi-rename
pi --no-extensions -e ./extensions/pi-rename
```

## Provides

- `/rename <name>` — set the current session display name. The name is always stored as
  a **slug**: lowercase, ASCII alphanumerics separated by single hyphens, diacritics
  stripped, capped at 4 words (e.g. `Refactor Auth Module!` → `refactor-auth-module`,
  `Café` → `cafe`).
- `/rename` — invent a slug from your **most recent activity** and apply it directly. It
  reads the latest user message (skipping a bare `/rename` or an empty turn), so calling
  it again as the conversation evolves produces a fresh, current name and replaces the
  previous one instead of being stuck on how the session opened. It never opens an input
  dialog: pass a name to use it, or pass nothing to have one invented.

The current name is shown as an inverted-color "pill" (foreground/background swapped)
embedded in the editor's **top border** (the violet prompt line) — right where the
dynamic-workflows router shows `ultracode auto`, with the border line continuing into
the name pill as `ultracode auto ── <slug>` (existing label first, name last) when both
are present. This mirrors Claude Code's
`/rename [name]`, which renames the current conversation, shows the name on the prompt
bar, and auto-generates one from history when none is given.

## Relationship to the native `/name`

Pi already ships a native `/name <name>` that sets the session display name. `/rename`
is a functional **superset** of it: same naming target, plus the no-argument
auto-generate path that `/name` lacks. `/rename` coexists with `/name` and never
overrides it — use whichever verb you prefer.

## Behavior details

- The name shown by `/resume` (and tooling) is the session display name, set via the
  same channel as `/name` (`pi.setSessionName`).
- Both the explicit and auto-generated names are slugified, so the stored name and the
  border label are always a clean slug of at most 4 words.
- The border label is added by a thin outer editor layer that delegates everything but
  rendering, so it works without importing or depending on dynamic-workflows, composes
  with that extension's `ultracode auto` label (placed first), and leaves scroll hints
  untouched. The name is rendered with reverse video (inverted fg/bg) as a pill.
- The auto-generated suggestion is **deterministic** (no LLM, no network): it is derived
  from the most recent non-empty user message (walking the history backward) — leading
  slash-command dropped, then slugified and truncated on a word boundary. Reading the
  latest message (rather than the first) is what lets a repeated `/rename` track what you
  are doing now.
- Fallbacks: empty history or no usable text falls back to a default name
  (`session`); if `setSessionName` fails it reports an error instead of crashing.
