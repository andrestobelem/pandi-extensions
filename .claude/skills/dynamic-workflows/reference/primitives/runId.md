# runId

**Runtime:** pi runtime (read-only run context)

**Signature:** `runId` (string) — this run's id

The unique id of the current workflow run, injected as a flat global.

**Returns:** the run id string.

## When to use / not

- **Use** to correlate logs/artifacts with the run, or to reference it in
  messages (`/workflow view <runId>`, `resume`).
- **Not** in prompts or cache keys as a varying token — it changes per run and
  would bust the prompt cache.

## Gotchas

- Read-only. Prefer artifacts under `runDir` over embedding `runId` into content.

## Example

```js
log(`starting run ${runId}`);
await writeArtifact("meta.json", { runId });
```
