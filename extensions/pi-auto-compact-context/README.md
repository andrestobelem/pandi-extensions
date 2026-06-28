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

- `/auto-compact-context` — show status, enable/disable, set threshold, or trigger compaction manually.
- Automatic compaction after an agent turn when context usage crosses the configured threshold.

Default threshold is `30%`. Override the startup default with `PI_AUTO_COMPACT_PERCENT`.

For the full bundle of extensions and skills, install the repository root instead.
