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

- `/auto-compact-context` — show status, enable/disable, set threshold, toggle the footer progress bar, or trigger compaction manually.
  - `/auto-compact-context bar [on|off]` — show, hide, or toggle the footer progress bar.
- Automatic compaction after an agent turn when context usage crosses the configured threshold.
- A footer **progress bar** that shows how close context usage is to the threshold (`compact ▰▰▱▱▱▱▱▱ 9%/30%`). It fills as usage approaches the threshold, turns to a warning color when near, and shows a `compacting…` state while compaction runs.

Default threshold is `30%`. Override the startup default with `PI_AUTO_COMPACT_PERCENT`.
The progress bar is on by default; set `PI_AUTO_COMPACT_BAR=off` to hide it at startup.

For the full bundle of extensions and skills, install the repository root instead.
