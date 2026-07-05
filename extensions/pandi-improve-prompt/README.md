# @pandi-coding-agent/pandi-improve-prompt

Rewrite a rough prompt draft into a clearer, more actionable one before you send it — a small
`/improve-prompt` command for Pi.

```
/improve-prompt fix the bug in the parser
```

One-shot model call (no tools) rewrites the draft: resolves ambiguity, adds concrete/verifiable
success criteria when it helps, and keeps your language and intent. The rewrite is shown for
review — a scrollable overlay in the TUI, a plain notify in RPC — and then you're asked whether
to **send it** as your next message. Confirm and it is injected as a real user turn (like
`/plan`'s approval wake); decline and nothing is sent, the rewrite just stayed on screen.

In `--print`/`json` (headless, one-shot) mode there is no way to ask for confirmation, so the
rewrite is printed and nothing is sent — sending it unreviewed would be a silent side effect.

## Install

From npm:

```bash
pi install npm:@pandi-coding-agent/pandi-improve-prompt
```

From this repository:

```bash
pi install ./extensions/pandi-improve-prompt          # global (your user)
pi install -l ./extensions/pandi-improve-prompt        # project-local
pi --no-extensions -e ./extensions/pandi-improve-prompt   # one-off trial, nothing else loaded
```

## Commands

| Command | What it does |
| --- | --- |
| `/improve-prompt <draft>` | Rewrite the draft clearer, show it for review, then ask whether to send it as your next message. |
| `/improve-prompt` | With no draft, shows a usage notification. |

## How it works

- Deliberately **standalone**: unlike `/btw`, the draft is judged on its own text, not grounded
  in the current conversation branch, so it rewrites a loose draft the same whether or not there
  is prior chat history.
- The request is built with `completeSimple()` and carries **no tools**, so the model can only
  answer in text — the pure request/answer logic lives in `build-improve-context.ts`.
- The overlay is vendored from `pandi-btw`'s (cross-extension duplication is intentional, so each
  extension can be published standalone); it scrolls with `↑/↓` `j/k` and `PgUp/PgDn`, closes with
  `q`/`Esc`.
- Sending is the one deliberate write: `pi.sendUserMessage()` — a direct steer when idle, a
  `followUp` mid-stream — fires **only** after you confirm via `ctx.ui.confirm`.
