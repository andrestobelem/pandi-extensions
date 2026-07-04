# writeArtifact

Saves a named file under the run's own output folder (`runDir`) instead of the
chat log, so findings, drafts, and reports stay inspectable after the run ends
and show up live in the dashboard / `/workflow view`.

```js
const findings = await agents(files, { concurrency: 8, settle: true });
await writeArtifact("findings.json", findings.filter(Boolean));
const summary = await agent(`Synthesize:\n${compact(findings)}`, { effort: "high" });
await writeArtifact("summary.md", summary);
```

**Runtime:** pi runtime

**Signature:** `writeArtifact(name, data) → Promise<{ path }>`

**Returns:** `{ path }` — the absolute artifact path.

## Concept

`data` is written as-is when it's a `string` or `Uint8Array`; anything else
(objects, arrays, numbers) is JSON-serialized for you. Each call also emits an
`artifact` event, which is what makes the file appear live in the dashboard.

## When to use / not

| Situation | Use |
| --- | --- |
| Intermediate/final output you want auditable after the run (findings, synthesis, evidence) | `writeArtifact` |
| A file that belongs in the repo/workspace | [`writeFile`](writeFile.md) (targets `cwd`, not `runDir`) |
| Building up one artifact incrementally across calls (e.g. a live log) | [`appendArtifact`](appendArtifact.md) — `writeArtifact` overwrites each call |

## Gotchas

- Lives under `runDir` (run-scoped), not `cwd` — don't reach for it to write
  workspace files.
- Overwrites on every call; use `appendArtifact` for incremental writes so
  concurrent agents don't corrupt a shared file.
- Prefer artifacts over dumping large intermediate results into the chat/log.

## Example

```js
const files = await listFiles("src", { recursive: true });
const reviews = await agents(
  files.map((f) => `Review ${f} for bugs.`),
  { concurrency: 8, settle: true },
);
const { path } = await writeArtifact("review.json", reviews.filter(Boolean));
log(`Wrote review artifact to ${path}`);
```
