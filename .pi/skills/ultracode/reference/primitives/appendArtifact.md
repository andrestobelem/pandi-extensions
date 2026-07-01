# appendArtifact

**Runtime:** pi runtime

**Signature:** `appendArtifact(name, data) → Promise<{ path }>`

Append to a named artifact under the run's `runDir`. `data` is a string or
`Uint8Array`. Writes are **serialized per path** (an internal mutex) so
concurrent agents appending to a shared artifact never interleave a partial write
and corrupt it. Emits an `artifact_append` event.

**Returns:** `{ path }` — the absolute artifact path.

## When to use / not

- **Use** to stream a shared, run-scoped log/artifact from many concurrent
  branches (e.g. each agent appends its finding line).
- **Not** for `cwd` files (use [`appendFile`](appendFile.md)) or one-shot writes
  (use [`writeArtifact`](writeArtifact.md)).

## Gotchas

- Concurrency-safe by design (per-path mutex) — this is why it beats `appendFile`
  for parallel appenders.
- Run-scoped (`runDir`), inspectable in the dashboard.

## Example

```js
const results = await agents(items, { concurrency: 8, settle: true });
for (const [i, r] of results.entries()) {
  if (r) await appendArtifact("findings.log", `#${i}: ${r.output}\n`);
}
```
