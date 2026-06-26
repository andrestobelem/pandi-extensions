# pi-dynamic-workflows-local-memory

Individual Pi package for the local memory extension.

## Install

From this repository:

```bash
pi install ./extensions/pi-local-memory
pi install -l ./extensions/pi-local-memory
pi --no-extensions -e ./extensions/pi-local-memory
```

## Provides

- Reads `.pi/MEMORY.md` from the current project when present.
- Appends that memory as a tagged block to the per-turn system prompt.

Use this only for trusted project-local notes. For the full bundle of extensions and skills, install the repository root instead.
