# phase

`phase(label)` is a sticky label for "what stage is this run in right now" —
purely for humans watching the dashboard/logs, not for the workflow's own
logic. Reach for it whenever a run has more than one visible stage and you
want the log/dashboard to read as a story instead of a flat list of calls.

```js
phase("scout");
const files = await agent("List high-risk files", { model: "haiku" });
phase("fan-out");
const findings = await agents(files, { concurrency: 8 });
phase("synthesize");
return await agent(`Synthesize:\n${compact(findings)}`, { effort: "high" });
```

**Runtime:** shared (pi + Claude Code)

**Signature:** `phase(label) → void`

Writes `phase: <label>` to the log and groups subsequent activity under that
label in the dashboard/live view, until the next `phase()` call. `phase(null)`
clears the current label (and logs nothing).

**Returns:** nothing.

## When to use / not

| Situation | Use `phase()`? |
| --- | --- |
| Multi-stage run (scout → fan-out → synthesize) | Yes — labels the story for readers |
| One-shot single `agent()` call | No — nothing to label |
| Need to branch behavior on the current stage | No — it's observability-only, not state to read back |
| Gating/waiting for a stage to finish | No — use `await`/`pipeline()`, `phase()` changes no behavior |

## Gotchas

- Cosmetic only: it never gates, awaits, or blocks anything — a workflow with
  zero `phase()` calls behaves identically, just with a flatter log.
- Labels show up verbatim in the log/dashboard; keep them short, stable,
  human-readable strings ("fan-out", not a changing progress percentage).
- `phase(null)` clears the label without emitting a log line — use it between
  unrelated stages if you don't want a trailing label to linger.

## Example

```js
export default async function main() {
  phase("scout");
  const files = await agent("List high-risk files", { model: "haiku" });
  phase("fan-out");
  const findings = await agents(files, { concurrency: 8 });
  phase("synthesize");
  const summary = await agent(`Synthesize:\n${compact(findings)}`, { effort: "high" });
  phase(null);
  return summary;
}
```
