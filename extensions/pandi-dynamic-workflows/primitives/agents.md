# agents

**Runtime:** shared (pi + Claude Code)

`agents()` runs the **same one step**, in parallel, over a list of independent
items — think "classify every file" or "get N reviewers to look at the same
diff." Reach for it whenever items don't depend on each other and each needs
just one subagent call.

```js
const results = await agents(
  files.map((f) => ({ prompt: `Classify risk of ${f}:\n${readFile(f)}`, name: f })),
  { concurrency: 8, settle: true, model: "haiku", effort: "low" },
);
const ok = results.filter(Boolean);
log(`classified ${ok.length}/${files.length} (${files.length - ok.length} failed)`);
```

## Signature

`agents(items, options?) → Promise<(SubagentResult | null)[]>`

- `items`: array of prompt strings or `AgentSpec` objects
  (`{ prompt, name, model, effort, … }`).
- `options`: shared per-call defaults (model/effort/tools/…), applied to every
  item; fields on an individual `AgentSpec` override them.
- `options.concurrency`: max in-flight calls, clamped to `limits.concurrency`.
- `options.settle`: `true` makes a failed branch resolve to `null` instead of
  rejecting the whole batch.

**Returns:** an array aligned to `items`. Each entry is a `SubagentResult`
envelope (`.output` text, `.data` parsed, `.schemaOk`), or `null` for a failed
branch when `settle: true`.

## When to use / not

| Situation | Primitive |
| --- | --- |
| One independent step per item (scout, classify, per-doc extract) | `agents` |
| 2+ dependent stages per item, no cross-item merge | `pipeline` |
| A later step needs ALL results at once (barrier: dedup, rank, merge) | `parallel` |

## Gotchas

- Include a **stable id/index** in each per-item prompt so two items never race
  for the same cache slot.
- **Filter nulls** and `log()` how many branches failed; synthesis prompts must
  name failed/empty branches instead of hiding them.
- `concurrency` above `limits.concurrency` is clamped — `log()` the clamp.

## Example

```js
const files = await scanRepo();
const results = await agents(
  files.map((f, i) => ({ prompt: `[${i}] Review ${f} for security issues`, name: f })),
  { concurrency: 5, settle: true, effort: "medium" },
);
const findings = results.filter(Boolean).map((r) => r.data ?? r.output);
log(`reviewed ${findings.length}/${files.length} files`);
return await agent(`Summarize findings:\n${JSON.stringify(findings)}`);
```
