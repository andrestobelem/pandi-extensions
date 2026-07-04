# workflow

**Runtime:** shared (pi + Claude Code)

`workflow()` lets one workflow script call another saved workflow by name and
get back its return value — no human decision gate in between. Use it to
reuse a scaffold (e.g. a `*-lib` verifier) instead of re-implementing it
inline.

```js
// inside a driver workflow
const verified = await workflow("verify-claims-lib", { claims, evidence });
return verified.filter((c) => c.status === "confirmed");
```

**Signature:** `workflow(name, args) → Promise<result>`

**Returns:** the sub-workflow's returned value.

## When to use / not

| Situation | Do this |
| --- | --- |
| Reusable sub-step, no decision needed on its result | `workflow("name", args)` |
| Must inspect the sub-result before choosing the next phase | run separate workflows sequentially instead |
| The reusable step needs to itself call another sub-workflow | not supported — flatten it, or make it a sibling top-level workflow |

## Gotchas

- **Composition is depth-1, strictly.** A sub-workflow's own `workflow` call
  throws `"workflow() composition depth limit is 1: sub-workflows cannot
  call other sub-workflows."` — only the top-level workflow may compose. This
  is the same in pi and Claude Code (shared runtime code).
- **No calling your own file.** Calling a workflow that resolves to the same
  file as the current one throws (`refused recursive call`) — no
  self-recursion via `workflow()`.
- Don't confuse this with `PI_DYNAMIC_WORKFLOWS_MAX_DEPTH` (pi only, default
  2): that guards *nested top-level runs* started by a subagent's
  `dynamic_workflow` tool, a separate mechanism from `workflow()` composition.
- Declare provenance: set `meta.basedOn` (array of `{ name, role }`) for every
  scaffold you compose.

## Example

```js
export default async function main(ctx, input) {
  const claims = await agent(`extract claims from: ${input.request}`);
  const verified = await workflow("verify-claims-lib", {
    claims,
    evidence: input.evidence,
  });
  return verified.filter((c) => c.status === "confirmed");
}
```
