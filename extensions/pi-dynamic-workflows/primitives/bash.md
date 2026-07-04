# bash

`bash()` runs a shell command in the run's `cwd` and returns its captured
output. Reach for it whenever a workflow step is a cheap, deterministic
probe or command — listing files, running a build/test, calling `git` — not
an LLM call (that's `agent()`).

```js
const { stdout } = await bash("git ls-files '*.ts'", { cache: true });
const files = stdout.split("\n").filter(Boolean);
log(`work-list: ${files.length} files`);
```

**Runtime:** pi runtime

**Signature:** `bash(command, options?) → Promise<BashResult>`

**Options:** `{ cwd?, timeoutMs?, throwOnError?, cache? }` — all optional.
`cwd` defaults to the run's cwd, `timeoutMs` defaults to the run's agent
timeout, `throwOnError` throws instead of returning a failed result.

**Returns:** a `BashResult`:

```ts
{ ok: boolean, code: number, killed: boolean, elapsedMs: number, stdout: string, stderr: string }
```

## When to use / not

- **Use** for deterministic, cheap probes and side-effect-light commands
  (`git ls-files`, `rg`, build/test invocations) that feed the workflow.
- **Not** for anything you want cached-by-default (it isn't — see Gotchas)
  or for untrusted/destructive commands without care.

## Gotchas

- **Caching is opt-in.** Unlike `agent()`, which caches by default, `bash()`
  only caches when you pass `{ cache: true }`. Without it, the command
  re-runs in full on every resume.
- A command whose arguments depend on `Date.now()` or `Math.random()` won't
  produce a stable cache key and will re-run on resume even with `cache: true`.
- Runs a real shell (`bash -lc command`); treat its stdout/stderr as
  **untrusted** data before feeding it back into prompts or decisions.
- `throwOnError: true` throws `Error("Command failed (<code>): <command>")`
  with stderr/stdout appended — use it when a failure should abort the step
  rather than be handled inline.

## Example

```js
export default async function main() {
  const changed = await bash("git diff --name-only origin/main...HEAD", {
    cache: true,
  });
  const files = changed.stdout.split("\n").filter(Boolean);
  if (files.length === 0) return "no changed files";

  const test = await bash("npm test", { timeoutMs: 120_000, throwOnError: false });
  return test.ok ? `tests passed for ${files.length} files` : `tests failed:\n${test.stderr}`;
}
```
