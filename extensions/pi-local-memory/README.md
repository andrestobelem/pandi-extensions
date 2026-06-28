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
- `remember` model tool: lets Pi persist a durable note to `.pi/MEMORY.md` **on its own
  initiative** (stable preferences, project conventions, key decisions). It appends only to a
  managed block (`<!-- pi:remember:begin -->` … `<!-- pi:remember:end -->`) so human-curated
  notes are never touched, is idempotent (re-saving the same note is a no-op), and fails safe
  on read/write errors. The note flows back into your context next session via the reader above.

## Trust boundary

When loaded (e.g. globally), this extension auto-injects `.pi/MEMORY.md` from whatever project you open into the system prompt on every turn — there is no prompt, allowlist, or provenance check. Open only **trusted** projects: a repository you do not control could ship a committed `.pi/MEMORY.md` to influence the assistant. Literal `</local_memory>` tags in the file are escaped so the content cannot break out of its block.

Use this only for trusted project-local notes. For the full bundle of extensions and skills, install the repository root instead.
