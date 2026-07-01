# phase

**Runtime:** shared (pi + Claude Code)

**Signature:** `phase(label) → void`

Mark the current phase of the run. It is a lightweight observability marker: the
label is written to the log (`phase: <label>`) and groups subsequent activity in
the dashboard/live view. `phase(null)` clears it.

**Returns:** nothing.

## When to use / not

- **Use** to make a multi-stage run readable ("scout", "fan-out", "synthesize")
  so the dashboard and logs show progress by stage.
- **Not** for control flow — it changes no behavior, only observability.

## Gotchas

- Purely cosmetic/observability; it does not gate or await anything.
- Use stable, human-readable labels; they show up verbatim.

## Example

```js
phase("scout");
const files = await agent("List high-risk files", { model: "haiku" });
phase("fan-out");
const findings = await agents(files, { concurrency: 8 });
phase("synthesize");
return await agent(`Synthesize:\n${compact(findings)}`, { effort: "high" });
```
