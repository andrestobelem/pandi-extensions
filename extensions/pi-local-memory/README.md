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

Claude-style memory **folder** at `.pi/memory/`:

- **`.pi/memory/MEMORY.md`** is the index/entrypoint. The extension injects it as a tagged block
  into the per-turn system prompt, **capped to the first 200 lines or 25 KB** (whichever hits
  first). For backward compatibility it falls back to the pre-folder `.pi/MEMORY.md` when the
  folder index is absent.
- **`.pi/memory/<topic>.md`** are topic files. They are **not** injected; instead the injected
  block lists their paths so Pi reads them **on demand** with its file tools.
- `remember` model tool: lets Pi persist a durable note **on its own initiative** (stable
  preferences, project conventions, key decisions). With no `topic` the note goes to the
  injected index; with a `topic` it goes to `.pi/memory/<topic>.md` (the topic is slugified, so
  path traversal is impossible). It appends only to a managed block
  (`<!-- pi:remember:begin -->` … `<!-- pi:remember:end -->`) so human-curated notes are never
  touched, is idempotent (re-saving the same note is a no-op), and fails safe on read/write
  errors. The first index write seeds from any legacy `.pi/MEMORY.md` (never deleting it), and
  the note flows back into your context next session via the reader above.

## Trust boundary

When loaded (e.g. globally), this extension auto-injects the `.pi/memory/MEMORY.md` index (or the legacy `.pi/MEMORY.md`) from whatever project you open into the system prompt on every turn — there is no prompt, allowlist, or provenance check. Open only **trusted** projects: a repository you do not control could ship a committed index to influence the assistant. Topic files are lower risk because they are listed but never auto-injected. Literal `</local_memory>` tags in the injected index are escaped so the content cannot break out of its block, and the index is length-capped before injection.

Use this only for trusted project-local notes. For the full bundle of extensions and skills, install the repository root instead.
