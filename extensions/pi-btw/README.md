# @pandi-coding-agent/btw

Ask a quick side question about the current conversation with a Claude-style `/btw` command — one answer, no tool access, never added to the conversation history.

Use it for "what did we decide?" / "which file was that?" lookups about context the model already has — not for tasks that need new file reads, commands, or web searches.

## Install

From npm:

```bash
pi install npm:@pandi-coding-agent/btw
```

From this repository:

```bash
pi install ./extensions/pi-btw          # global (your user)
pi install -l ./extensions/pi-btw       # project-local
pi --no-extensions -e ./extensions/pi-btw   # one-off trial, nothing else loaded
```

## Commands

| Command | What it does |
| --- | --- |
| `/btw <question>` | Ask a side question over the current conversation; the answer appears in a dismissible overlay and is never added to history. |
| `/btw` | With no question, prints usage. |

In the TUI, the answer opens in a scrollable overlay (`↑/↓` `j/k` scroll, `PgUp/PgDn` page, `q`/`Esc` close). In non-TUI modes (`--print`, RPC/JSON) it is printed or shown as a notification.

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
