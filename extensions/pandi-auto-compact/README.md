# @pandi-coding-agent/pandi-auto-compact

Long Pi sessions eventually run out of context, and a plain `/compact` can quietly lose
facts you needed. This extension watches context usage and compacts automatically once
it crosses a threshold (default `35%` for Claude/other models, `50%` for Codex), with a footer gauge so you see it coming, a
fast bounded summary hook (Sonnet 5 by default, GPT 5.5 for Codex sessions), and a disk snapshot so a lossy summary is never unrecoverable.

## Quickstart

```bash
pi install npm:@pandi-coding-agent/pandi-auto-compact
```

```text
/auto-compact                 # open the interactive menu (UI session)
/auto-compact status          # show threshold, bar, summary, snapshot, clear-tools state
/auto-compact 50              # override the model-sensitive default threshold
/auto-compact summary off     # fall back to Pi's native compaction summary
/auto-compact clear-tools on  # also elide old tool output on every LLM call
```

Other install modes: `pi install ./extensions/pandi-auto-compact` (global), add `-l`
(project-local), or `pi --no-extensions -e ./extensions/pandi-auto-compact` (one-off trial).
Compaction itself runs automatically after an agent turn once usage crosses the threshold.

## Commands

| Command | What it does |
| --- | --- |
| `/auto-compact` | Bare in a UI session: opens an interactive settings menu. Otherwise shows status. |
| `/auto-compact status` | Show current settings. |
| `/auto-compact on\|off` | Enable or disable auto-compaction (`enable`/`disable` also work). |
| `/auto-compact run` | Compact context now (`compact` also works). |
| `/auto-compact <1-99>` | Set the compaction threshold percent. |
| `/auto-compact bar [on\|off]` | Show, hide, or toggle the footer progress bar, e.g. `compact ▰▰▱▱▱▱▱▱ 9%/35%`. |
| `/auto-compact summary [on\|off]` | Toggle the fast bounded compaction summary hook. |
| `/auto-compact snapshot [on\|off]` | Toggle recoverable pre-compaction snapshots. |
| `/auto-compact snapshots` | List recent snapshot paths for the current session. |
| `/auto-compact clear-tools [on\|off]` | Toggle eliding old large tool outputs per LLM call. |

## How it works

**Fast summary** (on by default): before Pi writes a compaction entry, the extension tries
to summarize with a bounded operational prompt and a model picked for the current session:
`anthropic/claude-sonnet-5` normally, `openai-codex/gpt-5.5` for Codex sessions. Override
with `PI_AUTO_COMPACT_SUMMARY_MODEL=provider/model` or disable with
`/auto-compact summary off`. If model lookup, auth, or summarization fails, Pi falls back to
its native compactor.

**Snapshots** (fail-safe, gitignored): on any compaction path (manual, threshold,
overflow recovery), raw entries are written to
`<cwd>/.pi/compaction-snapshots/<sessionId>/<timestamp>-<reason>.json`, then patched with
the summary afterward — a write error never blocks compaction. Separate from
`.pi/memory/` (curated facts, not raw transcripts).

**Tool-result clearing** (off by default, ephemeral, non-destructive, cheaper than full
compaction): before each LLM call, elides bulky text of old, consumed tool results,
keeping a head/tail snippet. Only `toolResult` text is touched (`toolCallId`/`toolName`/
`isError`/images preserved); recent and error results are never cleared; toggling off
restores full originals immediately, independent of the compaction threshold.

## Details

Startup defaults, overridable via environment variables:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PI_AUTO_COMPACT_PERCENT` | model-sensitive (`35` normally, `50` for Codex) | Compaction threshold percent. |
| `PI_AUTO_COMPACT_BAR` | `on` | Footer progress bar visibility. |
| `PI_AUTO_COMPACT_FAST_SUMMARY` | `on` | Use the fast bounded custom compaction summary. |
| `PI_AUTO_COMPACT_SUMMARY_MODEL` | model-sensitive (`anthropic/claude-sonnet-5`, Codex → `openai-codex/gpt-5.5`) | Summary model override as `provider/model`. |
| `PI_AUTO_COMPACT_SUMMARY_MAX_TOKENS` | `4096` | Max output tokens for the summary call. |
| `PI_AUTO_COMPACT_SUMMARY_MAX_INPUT_CHARS` | `80000` | Max serialized input chars sent to the summary prompt. |
| `PI_AUTO_COMPACT_SNAPSHOT` | `on` | Recoverable pre-compaction snapshots. |
| `PI_AUTO_COMPACT_SNAPSHOT_KEEP` | `20` | Per-session snapshot retention budget. |
| `PI_AUTO_COMPACT_CLEAR_TOOL_RESULTS` | `off` | Tool-result clearing. |
| `PI_AUTO_COMPACT_CLEAR_KEEP_RECENT` | `3` | Most recent tool results kept intact. |
| `PI_AUTO_COMPACT_CLEAR_MIN_CHARS` | `2000` | Only elide tool-result text longer than this. |

## Related

For the full bundle of extensions and skills, install the repository root instead.
