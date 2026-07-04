# runId

`runId` is the unique id of the current workflow run, injected as a
read-only global string. Use it to tag logs, artifacts, or messages so a
human (or another tool) can find this exact run later — for example in
`/workflow view <runId>` or `resume`.

```js
log(`starting run ${runId}`);
await writeArtifact("meta.json", { runId });
```

**Runtime:** pi runtime (read-only run context)

**Signature:** `runId` (string) — this run's id

**Returns:** the run id string.

## When to use / not

- **Use** to correlate logs/artifacts with the run, or to reference it in
  messages (`/workflow view <runId>`, `resume`).
- **Not** in prompts or cache keys as a varying token — it changes per run
  and would bust the prompt cache.

## Gotchas

- Read-only. Prefer artifacts under `runDir` over embedding `runId` into
  content.

## Example

```js
export default async function main() {
  log(`starting run ${runId}`);
  const result = await agent("summarize the target repo", { model: "sonnet" });
  await writeArtifact("summary.json", { runId, result });
  return `run ${runId} complete`;
}
```
