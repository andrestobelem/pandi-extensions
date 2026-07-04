# @pandi-coding-agent/rename

Give the current Pi session a short, memorable name instead of a UUID, so `/resume`, `pi -r`, and the exit hint are easy to scan. Pass a name to use it as-is, or call `/rename` with nothing and it summarizes your most recent activity into one — a Claude-style `/rename` for Pi.

```text
/rename Refactor auth module   ->  refactor-auth-module
/rename "Hello World!"         ->  hello-world
/rename Café                   ->  cafe
/rename                        ->  (LLM summarizes recent activity, e.g. debug-flaky-test)
```

## `/rename` vs Pi's native `/name`

| Want to...                              | Use                                              |
| ---------------------------------------- | ------------------------------------------------- |
| Set an exact session name                | `/rename <name>` or `/name <name>` (same effect) |
| Auto-generate a name from recent work    | `/rename` with no argument — `/name` has no equivalent |

`/rename` is a functional **superset** of `/name`: same naming target (`pi.setSessionName`), plus the auto-generate path. It coexists with `/name` and never overrides it.

Every name is stored as a **slug**: lowercase ASCII, hyphen-separated, diacritics stripped, max 4 words / 60 chars. The current name shows as an inverted-color pill in the editor's top border, and as a `Session name:` hint on exit.

## Install

From npm:

```bash
pi install npm:@pandi-coding-agent/rename
```

From this repository:

```bash
pi install ./extensions/pi-rename          # global (your user)
pi install -l ./extensions/pi-rename       # project-local
pi --no-extensions -e ./extensions/pi-rename   # one-off trial, nothing else loaded
```

## Commands

| Command | What it does |
| --- | --- |
| `/rename <name>` | Slugify `<name>` and set it as the session display name (instant, no LLM). |
| `/rename` | Summarize your most recent activity via the LLM into a slug and apply it directly, no dialog. |

## How it works

- **Auto-naming:** a one-shot `pi -p` subprocess summarizes the most recent part of the conversation into a short title, which is slugified. Re-running `/rename` as work evolves replaces the name with a fresh, current one.
- **Subprocess isolation:** the summary run uses `--no-extensions --no-skills --no-context-files --no-approve`, is bounded by a ~12s timeout, and uses your configured model. Override the binary with `PI_RENAME_PI_COMMAND` and the model with `PI_RENAME_MODEL`.
- **Deterministic fallback:** if the LLM is unavailable (offline, no API key, timeout), `/rename` slugifies the most recent non-empty user message (leading slash-command dropped, truncated on a word boundary). It always produces a name and never blocks indefinitely.
- **Border pill:** a thin outer editor layer overrides only rendering, so it needs no dependency on dynamic-workflows and composes with that extension's label as `ultracode auto ── <slug>` when both are present. The name is rendered in reverse video (inverted fg/bg).
- **Same channel as `/name`:** names are set via `pi.setSessionName`, so `/resume`, the resume selector (`pi -r`), and `/name` with no arguments all show the same slug.

## Limitations & safety notes

- Empty history or no usable text falls back to the default name `session`; if `setSessionName` fails, `/rename` reports an error instead of crashing.
- The exit-time `Session name: <slug> (resume by name: pi -r)` line prints only in the TUI on a TTY, and stays silent when the session is unnamed.
- Pi core's own exit hint (`To resume this session: pi --session <uuid>`) is UUID-only by design — `--session` resolves paths/partial UUIDs, not names. Upstream FR to include the name: [earendil-works/pi#6296](https://github.com/earendil-works/pi/issues/6296).

## Related

For the full bundle of extensions and skills, install the repository root instead.
