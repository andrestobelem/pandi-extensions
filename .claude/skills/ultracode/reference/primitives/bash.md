# bash

**Runtime:** pi runtime

**Signature:** `bash(command, options?) → Promise<BashResult>`

Run a shell command in the run's `cwd`. Returns the captured result
(stdout/stderr/exit). Caching is **opt-in**: `bash(cmd, { cache: true })`.

**Returns:** a `BashResult` (stdout, stderr, exit code).

## When to use / not

- **Use** for deterministic, cheap probes and side-effect-light commands (`git
  ls-files`, `rg`, build/test invocations) that feed the workflow.
- **Not** for anything you want cached-by-default (it is not) or for
  untrusted/destructive commands without care.

## Gotchas

- **Caching is opt-in** (unlike `agent()`, which caches by default). Only pass
  `{ cache: true }` for deterministic commands — otherwise it re-runs on resume.
- A command whose arguments depend on `Date.now()`/`Math.random()` won't cache
  and will re-run on resume.
- Runs a real shell; treat command output as **untrusted** data.

## Example

```js
const { stdout } = await bash("git ls-files '*.ts'", { cache: true });
const files = stdout.split("\n").filter(Boolean);
log(`work-list: ${files.length} files`);
```
