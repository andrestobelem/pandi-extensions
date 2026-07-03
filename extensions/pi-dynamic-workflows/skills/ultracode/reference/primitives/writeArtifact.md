# writeArtifact

**Runtime:** pi runtime

**Signature:** `writeArtifact(name, data) → Promise<{ path }>`

Write a named artifact under the run's `runDir`. Strings and `Uint8Array` are
written as-is; anything else is JSON-serialized. Emits an `artifact` event so the
file shows up in the dashboard / `/workflow view`.

**Returns:** `{ path }` — the absolute artifact path.

## When to use / not

- **Use** to persist inspectable intermediate/final outputs (findings, the
  synthesis, evidence) outside the chat context — the preferred way to keep a run
  auditable.
- **Not** for files that belong in the repo/workspace — use
  [`writeFile`](writeFile.md) (that targets `cwd`).

## Gotchas

- Lives under `runDir` (run-scoped), not `cwd`.
- Prefer artifacts over dumping large intermediate results into the chat/log.

## Example

```js
const findings = await agents(files, { concurrency: 8, settle: true });
await writeArtifact("findings.json", findings.filter(Boolean));
const summary = await agent(`Synthesize:\n${compact(findings)}`, { effort: "high" });
await writeArtifact("summary.md", summary);
```
