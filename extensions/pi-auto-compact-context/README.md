# pi-dynamic-workflows-auto-compact-context

Individual Pi package for the `auto-compact-context` extension.

## Install

From this repository:

```bash
pi install ./extensions/pi-auto-compact-context
pi install -l ./extensions/pi-auto-compact-context
pi --no-extensions -e ./extensions/pi-auto-compact-context
```

## Provides

- `/auto-compact-context` — show status, enable/disable, set threshold, toggle the footer progress bar, manage recoverable snapshots, or trigger compaction manually.
  - `/auto-compact-context bar [on|off]` — show, hide, or toggle the footer progress bar.
  - `/auto-compact-context snapshot [on|off]` — toggle recoverable pre-compaction snapshots.
  - `/auto-compact-context snapshots` — list recent snapshot paths for the current session.
- Automatic compaction after an agent turn when context usage crosses the configured threshold.
- A footer **progress bar** that shows how close context usage is to the threshold (`compact ▰▰▱▱▱▱▱▱ 9%/30%`). It fills as usage approaches the threshold, turns to a warning color when near, and shows a `compacting…` state while compaction runs.

### Recoverable compaction

Compaction replaces raw conversation history with a **lossy** summary — a fact you later need can silently disappear. To make compaction *recoverable rather than destructive*, this extension snapshots the raw entries **before** the summary replaces them.

- On every compaction path (manual `/compact`, the threshold auto-compaction, overflow recovery, and this extension's own compaction) the raw entries about to be summarized are written to `<cwd>/.pi/compaction-snapshots/<sessionId>/<timestamp>-<reason>.json`.
- After compaction completes, the produced summary is patched into the same file, so each snapshot shows **what was dropped and what replaced it** (handy for auditing summary quality).
- The directory is under `.pi/` (gitignored) and is **deliberately separate from `.pi/memory/`**, which is for curated, injected facts — not bulky raw transcripts.
- Snapshotting is fully fail-safe: a write error never blocks or cancels compaction.
- Recover by reading the JSON path printed after compaction, or list recent ones with `/auto-compact-context snapshots`.

Default threshold is `30%`. Override the startup default with `PI_AUTO_COMPACT_PERCENT`.
The progress bar is on by default; set `PI_AUTO_COMPACT_BAR=off` to hide it at startup.
Snapshots are on by default; set `PI_AUTO_COMPACT_SNAPSHOT=off` to disable them, and `PI_AUTO_COMPACT_SNAPSHOT_KEEP=<n>` to change the per-session retention budget (default `20`).

For the full bundle of extensions and skills, install the repository root instead.
