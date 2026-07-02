# @pandi-coding-agent/btw

A Pi extension that adds a Claude-style `/btw` command: ask a quick **side question**
about the current conversation, get a single answer with **no tool access**, shown in a
dismissible overlay and **never added to the conversation history**.

It mirrors Claude Code's `/btw <question>` ("ask a quick side question without adding to
the conversation"): use it for *"what did we decide?"* / *"what file was that?"* lookups
about context the model already has — not for tasks that need new file reads, commands, or
web searches.

## Usage

```text
/btw what did we decide about the auth refactor?
/btw which file holds the retry logic?
/btw                                  # no question -> prints usage
```

- In the **TUI**, the answer opens in a scrollable overlay (`↑/↓` `j/k` scroll, `PgUp/PgDn`
  page, `q`/`Esc` close).
- In non-TUI modes (`--print`, RPC/JSON) the answer is printed or shown as a notification.

## How it works

1. The `/btw` command handler runs immediately when you submit — the typed text is **not**
   appended to the session.
2. It reads the current branch (`sessionManager.getBranch()`, read-only) and builds a
   one-shot request: the existing conversation + your question as a final user message,
   with a concise system prompt and **no tools**.
3. It calls the current model once via `completeSimple()` (reasoning is passed only for
   reasoning-capable models) and extracts the answer text.
4. It displays the answer with `ctx.ui` and returns — it **never** calls `pi.sendMessage`,
   `pi.appendEntry`, `pi.setSessionName`, or any session write, so the Q&A stays out of
   history.

## Files

- `index.ts` — orchestration: registers `/btw`, resolves model/auth, calls the model,
  renders the result.
- `build-btw-context.ts` — pure, SDK-free, unit-testable logic: extract conversation
  messages, build the one-shot request, extract the answer text.
- `answer-overlay.ts` — the scrollable TUI overlay (vendored from `pi-mdview`).

## Install

```bash
pi install ./extensions/pi-btw
```

## Notes / limitations

- The whole current branch is sent as context; very long sessions rely on the provider's
  own truncation. Truncating to recent turns is a possible future refinement.
- Because the answer is not stored, it is not searchable in session history — by design.
- Streaming the answer into the overlay (instead of awaiting the full reply) is a possible
  future enhancement.
