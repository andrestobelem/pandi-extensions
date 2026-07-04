# runDir

A read-only global string holding the absolute path to the current run's
directory — the folder where artifacts, events, and the journal for this
workflow run live. Reach for it when you need to log or reason about *where*
things landed, not to write files directly.

```js
log(`artifacts for this run live in ${runDir}`);
await writeArtifact("summary.md", summary); // resolved under runDir, emits an event
```

**Runtime:** pi runtime (read-only run context)

**Signature:** `runDir` (string) — this run's directory

**Returns:** the absolute run-directory path.

## When to use / not

- **Use** for awareness of where run-scoped output lands. Prefer the
  [`writeArtifact`](writeArtifact.md)/[`appendArtifact`](appendArtifact.md)
  helpers (they resolve names under `runDir` and emit events) over building paths
  by hand.
- **Not** for repo/workspace output — that belongs under [`cwd`](cwd.md).

## Gotchas

- Read-only. Files written straight to `runDir` (bypassing `writeArtifact`) won't
  emit an `artifact` event, so they won't show in the dashboard.

## Example

```js
export default async function main() {
  log(`run directory: ${runDir}`);
  const findings = await agent("scan the repo for TODOs");
  await writeArtifact("findings.md", findings);
  return `wrote findings under ${runDir}/artifacts/findings.md`;
}
```
