# agents

**Runtime:** shared (pi + Claude Code)

**Signature:** `agents(items, options?) → Promise<(SubagentResult | null)[]>`

Bounded parallel map: run **one independent step per item**. `items` is an array
of prompt strings or `AgentSpec` objects (`{ prompt, name, model, effort, … }`).
Shared options (model/effort/tools/…) apply to every item; per-item fields
override them. `concurrency` caps in-flight calls (clamped to
`limits.concurrency`); `settle: true` makes a failed branch resolve to `null`
instead of rejecting the batch.

**Returns:** an array aligned to `items`; each entry is a `SubagentResult`
envelope (`.output` text, `.data` parsed, `.schemaOk`) or `null` for a failed
branch under `settle`.

## When to use / not

- **Use** for a fan-out where each item is independent and needs the same one
  step (scout files, reviewer panel, extract-per-doc).
- **Not** when items need 2+ dependent stages (use `pipeline`) or when a later
  step needs ALL results at once as a barrier (use `parallel`).

## Gotchas

- Include a **stable id/index** in each per-item prompt so two items never race
  for the same cache slot.
- **Filter nulls** and `log()` how many branches failed; synthesis prompts must
  name failed/empty branches instead of hiding them.
- `concurrency` above `limits.concurrency` is clamped — `log()` the clamp.

## Example

```js
const results = await agents(
  files.map((f) => ({ prompt: `Classify risk of ${f}:\n${read(f)}`, name: f })),
  { concurrency: 8, settle: true, model: "haiku", effort: "low" },
);
const ok = results.filter(Boolean);
log(`classified ${ok.length}/${files.length} (${files.length - ok.length} failed)`);
```
