# pi-dynamic-workflows-auto-compact

Individual Pi package for the `auto-compact` extension.

## Install

From this repository:

```bash
pi install ./extensions/pi-auto-compact
pi install -l ./extensions/pi-auto-compact
pi --no-extensions -e ./extensions/pi-auto-compact
```

## Provides

- `/auto-compact` — show status, enable/disable, set threshold, toggle the footer progress bar, manage recoverable snapshots, or trigger compaction manually.
  - `/auto-compact bar [on|off]` — show, hide, or toggle the footer progress bar.
  - `/auto-compact snapshot [on|off]` — toggle recoverable pre-compaction snapshots.
  - `/auto-compact snapshots` — list recent snapshot paths for the current session.
  - `/auto-compact clear-tools [on|off]` — toggle eliding old large tool outputs per LLM call.
- Automatic compaction after an agent turn when context usage crosses the configured threshold.
- A footer **progress bar** that shows how close context usage is to the threshold (`compact ▰▰▱▱▱▱▱▱ 9%/35%`). It fills as usage approaches the threshold, turns to a warning color when near, and shows a `compacting…` state while compaction runs.

### Recoverable compaction

Compaction replaces raw conversation history with a **lossy** summary — a fact you later need can silently disappear. To make compaction *recoverable rather than destructive*, this extension snapshots the raw entries **before** the summary replaces them.

- On every compaction path (manual `/compact`, the threshold auto-compaction, overflow recovery, and this extension's own compaction) the raw entries about to be summarized are written to `<cwd>/.pi/compaction-snapshots/<sessionId>/<timestamp>-<reason>.json`.
- After compaction completes, the produced summary is patched into the same file, so each snapshot shows **what was dropped and what replaced it** (handy for auditing summary quality).
- The directory is under `.pi/` (gitignored) and is **deliberately separate from `.pi/memory/`**, which is for curated, injected facts — not bulky raw transcripts.
- Snapshotting is fully fail-safe: a write error never blocks or cancels compaction.
- Recover by reading the JSON path printed after compaction, or list recent ones with `/auto-compact snapshots`.

### Tool-result clearing (cheaper than compaction)

A lighter, **ephemeral** lever than full compaction. Before each LLM call, this extension can elide the bulky **text** of *old, already-consumed* tool results — keeping a head/tail snippet plus a marker — so stale tool output stops burning the per-call attention/token budget.

- **Non-destructive / recoverable:** it only rewrites what is sent to the model *for that call* (via the SDK `context` hook); the session keeps the originals, so turning it off restores full content immediately. No cascading-summary risk.
- **Pairing-safe:** only `toolResult` text is trimmed; `toolCallId`/`toolName`/`isError` and image blocks are preserved, so every tool call keeps its matching result.
- **Keeps what matters:** the most recent results stay intact (`keepRecent`), **error results are never cleared** (recovery signal), and short text (≤ `minChars`) is left alone. Idempotent and fully fail-safe (never blocks a call).
- **Independent from compaction:** it reduces per-call tokens/cost/latency and focus-noise, but does not change the compaction trigger (which is based on session usage).

It is **OFF by default** (it changes what the model sees every call); enable it for long, tool-heavy loops with `/auto-compact clear-tools on` or `PI_AUTO_COMPACT_CLEAR_TOOL_RESULTS=on`. Tune with `PI_AUTO_COMPACT_CLEAR_KEEP_RECENT=<n>` (default `3`) and `PI_AUTO_COMPACT_CLEAR_MIN_CHARS=<n>` (default `2000`).

Default threshold is `35%`. Override the startup default with `PI_AUTO_COMPACT_PERCENT`.
The progress bar is on by default; set `PI_AUTO_COMPACT_BAR=off` to hide it at startup.
Snapshots are on by default; set `PI_AUTO_COMPACT_SNAPSHOT=off` to disable them, and `PI_AUTO_COMPACT_SNAPSHOT_KEEP=<n>` to change the per-session retention budget (default `20`).

For the full bundle of extensions and skills, install the repository root instead.
