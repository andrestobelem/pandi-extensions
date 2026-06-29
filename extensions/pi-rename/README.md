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

- `/rename <name>` — set the current session display name (normalized: trimmed,
  wrapping quotes removed, internal whitespace collapsed).
- `/rename` — auto-generate a name from the conversation. In a TUI it opens an input
  dialog with the suggestion as placeholder so you can confirm or edit it; headless it
  applies the suggestion directly.

This mirrors Claude Code's `/rename [name]`, which renames the current conversation and
auto-generates a name from history when none is given.

## Relationship to the native `/name`

Pi already ships a native `/name <name>` that sets the session display name. `/rename`
is a functional **superset** of it: same naming target, plus the no-argument
auto-generate path that `/name` lacks. `/rename` coexists with `/name` and never
overrides it — use whichever verb you prefer.

## Behavior details

- The name shown by `/resume` (and tooling) is the session display name, set via the
  same channel as `/name` (`pi.setSessionName`).
- The auto-generated suggestion is **deterministic** (no LLM, no network): it is
  derived from the first non-empty user message — leading slash-commands and simple
  markdown markers stripped, whitespace collapsed, truncated on a word boundary.
- Fallbacks: empty history or no usable text falls back to a default name
  (`session`); cancelling the input dialog leaves the name unchanged; if
  `setSessionName` fails it reports an error instead of crashing.
