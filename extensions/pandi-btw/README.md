# @pandi-coding-agent/pandi-btw

Ask a quick side question about the current conversation without touching your session — a Claude-style `/btw` command for Pi. It answers from context the model already has, with no tool access, and the question/answer are never added to history.

Use it for "what did we decide?" / "which file was that?" lookups — not for tasks that need new file reads, commands, or web searches.

```
/btw what did we decide about auth?
```

The answer appears in a dismissible, scrollable overlay in the TUI (or is printed / shown as a notification outside the TUI) and is never written back to the session.

## Install

From npm:

```bash
pi install npm:@pandi-coding-agent/pandi-btw
```

From this repository:

```bash
pi install ./extensions/pandi-btw          # global (your user)
pi install -l ./extensions/pandi-btw       # project-local
pi --no-extensions -e ./extensions/pandi-btw   # one-off trial, nothing else loaded
```

## Commands

| Command | What it does |
| --- | --- |
| `/btw <question>` | Ask a side question over the current conversation; the answer appears in a dismissible overlay and is never added to history. |
| `/btw` | With no question, shows a usage notification (printed to the console only in `--print` mode or when there is no UI). |

In the TUI, the overlay scrolls with `↑/↓` `j/k` (line) and `PgUp/PgDn` (page); close it with `q` or `Esc`. In non-TUI modes (`--print`, RPC/JSON) the answer is printed or shown as a notification instead.

## How it works

- The `/btw` handler runs when you submit; your typed text is not appended to the session.
- It reads the current branch (read-only) and builds a one-shot request: the existing conversation plus your question, with a concise system prompt and **no tools**.
- It calls the current model once via `completeSimple()` and shows the answer with `ctx.ui` — it never performs any session write, so the Q&A stays out of history.

## Limitations & safety notes

- The whole current branch is sent as context; very long sessions rely on the provider's own truncation.
- Because the answer is not stored, it is not searchable in session history — by design.
- The answer is awaited in full before display (no streaming into the overlay).

## Related

For the full bundle of extensions and skills, install the repository root instead.
