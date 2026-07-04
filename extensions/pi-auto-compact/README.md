# @pandi-coding-agent/auto-compact

Automatically compacts Pi's context when usage crosses a configurable threshold — with a footer progress bar, recoverable pre-compaction snapshots, and an optional lighter lever that elides old bulky tool outputs.

## What you get

- Automatic compaction after an agent turn once context usage crosses the threshold (default `35%`).
- A footer progress bar (`compact ▰▰▱▱▱▱▱▱ 9%/35%`) that fills as usage approaches the threshold, warns when near, and shows `compacting…` while compaction runs.
- Recoverable snapshots: the raw entries a compaction is about to summarize are saved to disk first, so a lossy summary never silently destroys facts.
- Optional tool-result clearing: elide the text of old, already-consumed tool results per LLM call — cheaper and non-destructive compared to full compaction.

## Install

From npm:

```bash
pi install npm:@pandi-coding-agent/auto-compact
```

From this repository:

```bash
pi install ./extensions/pi-auto-compact          # global (your user)
pi install -l ./extensions/pi-auto-compact       # project-local
pi --no-extensions -e ./extensions/pi-auto-compact   # one-off trial, nothing else loaded
```

## Commands

| Command | What it does |
| --- | --- |
| `/auto-compact` | Bare in a UI session: opens an interactive settings menu. Otherwise shows status. |
| `/auto-compact status` | Show current settings. |
| `/auto-compact on\|off` | Enable or disable auto-compaction (`enable`/`disable` also work). |
| `/auto-compact run` | Compact context now (`compact` also works). |
| `/auto-compact <1-99>` | Set the compaction threshold percent. |
| `/auto-compact bar [on\|off]` | Show, hide, or toggle the footer progress bar. |
| `/auto-compact snapshot [on\|off]` | Toggle recoverable pre-compaction snapshots. |
| `/auto-compact snapshots` | List recent snapshot paths for the current session. |
| `/auto-compact clear-tools [on\|off]` | Toggle eliding old large tool outputs per LLM call. |

## How it works

**Recoverable snapshots.** Compaction replaces raw history with a lossy summary, so a fact you later need can disappear. To make that recoverable:

- On every compaction path (manual `/compact`, threshold auto-compaction, overflow recovery, and this extension's own compaction) the raw entries are written to `<cwd>/.pi/compaction-snapshots/<sessionId>/<timestamp>-<reason>.json` before the summary replaces them.
- After compaction, the produced summary is patched into the same file, so each snapshot shows what was dropped and what replaced it.
- Recover by reading the JSON path printed after compaction, or list recent ones with `/auto-compact snapshots`.

**Tool-result clearing.** Before each LLM call, the extension can elide the bulky text of old, already-consumed tool results — keeping a head/tail snippet plus a marker — so stale output stops burning the per-call token budget.

- Ephemeral and non-destructive: only what is sent to the model for that call is rewritten; the session keeps the originals, so turning it off restores full content immediately.
- Pairing-safe: only `toolResult` text is trimmed; `toolCallId`/`toolName`/`isError` and image blocks are preserved.
- Keeps what matters: the most recent results stay intact, error results are never cleared, and short text is left alone. Idempotent and fail-safe.
- Independent from compaction: it reduces per-call tokens and noise but does not change the compaction trigger, which is based on session usage.

## Limitations & safety notes

- Compaction is **lossy**: the summary replaces raw history. Snapshots exist precisely so that loss is recoverable — keep them on unless you have a reason not to.
- Snapshots live under `.pi/compaction-snapshots/` (gitignored), deliberately separate from `.pi/memory/`, which is for curated, injected facts — not bulky raw transcripts.
- Snapshotting is fail-safe: a write error never blocks or cancels compaction.
- Tool-result clearing is **off by default** because it changes what the model sees every call. Enable it for long, tool-heavy loops.

## Details

Startup defaults come from environment variables:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PI_AUTO_COMPACT_PERCENT` | `35` | Compaction threshold percent. |
| `PI_AUTO_COMPACT_BAR` | `on` | Footer progress bar visibility. |
| `PI_AUTO_COMPACT_SNAPSHOT` | `on` | Recoverable pre-compaction snapshots. |
| `PI_AUTO_COMPACT_SNAPSHOT_KEEP` | `20` | Per-session snapshot retention budget. |
| `PI_AUTO_COMPACT_CLEAR_TOOL_RESULTS` | `off` | Tool-result clearing. |
| `PI_AUTO_COMPACT_CLEAR_KEEP_RECENT` | `3` | Most recent tool results kept intact. |
| `PI_AUTO_COMPACT_CLEAR_MIN_CHARS` | `2000` | Only elide tool-result text longer than this. |

## Related

For the full bundle of extensions and skills, install the repository root instead.
