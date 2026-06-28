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

## Trust boundary

When loaded (e.g. globally), this extension auto-injects `.pi/MEMORY.md` from whatever project you open into the system prompt on every turn — there is no prompt, allowlist, or provenance check. Open only **trusted** projects: a repository you do not control could ship a committed `.pi/MEMORY.md` to influence the assistant. Literal `</local_memory>` tags in the file are escaped so the content cannot break out of its block.

Use this only for trusted project-local notes. For the full bundle of extensions and skills, install the repository root instead.
