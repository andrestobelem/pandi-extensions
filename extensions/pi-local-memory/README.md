# @pandi-coding-agent/local-memory

Give Pi a project-local memory folder (`.pi/memory/`): a capped `MEMORY.md` index is injected into the system prompt every turn, and Pi can persist durable notes on its own with a `remember` tool.

## What you get

- `.pi/memory/MEMORY.md` — the index, auto-injected each turn (capped to the first 200 lines or 25 KB, whichever hits first).
- `.pi/memory/<topic>.md` — topic files, never injected; the injected block lists their paths so Pi reads them on demand.
- `remember` model tool — lets Pi save stable preferences, project conventions, and key decisions for future sessions.
- Backward compatibility — falls back to the legacy `.pi/MEMORY.md` when the folder index is absent.

## Install

From npm:

```bash
pi install npm:@pandi-coding-agent/local-memory
```

From this repository:

```bash
pi install ./extensions/pi-local-memory          # global (your user)
pi install -l ./extensions/pi-local-memory       # project-local
pi --no-extensions -e ./extensions/pi-local-memory   # one-off trial, nothing else loaded
```

## Usage

| Surface | What it does |
| --- | --- |
| `remember` (no `topic`) | Model tool: appends a durable note to the injected index `.pi/memory/MEMORY.md`. |
| `remember` with `topic` | Model tool: appends the note to `.pi/memory/<topic>.md` (topic is slugified, so path traversal is impossible). |
| Per-turn injection | Injects the index (or legacy `.pi/MEMORY.md`) as a tagged block into the system prompt and lists topic-file paths. |

## How it works

- `remember` appends only inside a managed block (`<!-- pi:remember:begin -->` … `<!-- pi:remember:end -->`), so human-curated notes are never touched.
- Re-saving the same note is a no-op, and read/write errors fail safe: nothing is clobbered if the target could not be read.
- The first index write seeds from any legacy `.pi/MEMORY.md` without deleting it; the note flows back into context next session via the injection above.

## Limitations & safety notes

- **Trusted projects only.** When loaded (e.g. globally), the extension auto-injects `.pi/memory/MEMORY.md` (or the legacy `.pi/MEMORY.md`) from whatever project you open — no prompt, allowlist, or provenance check. A repository you do not control could ship a committed index to influence the assistant.
- Topic files are lower risk: they are listed but never auto-injected.
- Literal `</local_memory>` tags in the index are escaped, and the index is length-capped, so injected content cannot break out of its block structurally.
- **Write-side (anti-injection).** `remember` writes to a channel re-injected into future sessions' system prompts as trusted context — an authority boundary. The assistant should persist only facts it has itself verified, in its own words, and never copy untrusted retrieved/tool/web/user-pasted content (or instructions embedded in it) into memory. Delimiters are not a semantic security boundary; the real defense is not ingesting untrusted content in the first place.
- Use this only for trusted project-local notes.

## Related

For the full bundle of extensions and skills, install the repository root instead.
