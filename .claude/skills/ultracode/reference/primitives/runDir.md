# runDir

**Runtime:** pi runtime (read-only run context)

**Signature:** `runDir` (string) — this run's directory

The absolute path of the current run's directory, where artifacts and the
journal live. Injected as a flat global.

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
log(`artifacts for this run live in ${runDir}`);
await writeArtifact("summary.md", summary); // resolved under runDir, emits an event
```
