# agent

**Runtime:** shared (pi + Claude Code)

**Signature:** `agent(prompt, options?) → Promise<object | string | null>`

Run a single subagent. The prompt is a string (string-first on Claude). Options
set the per-call budget and access: `model`, `effort` (`low…max`) / `thinking`,
`schema`, `name`/`label`, `agentType` (`explore`/`reviewer`/`planner`/
`architect`/`implementer`/`researcher`), `tools`/`excludeTools`, `skills`, `extensions`,
`keys`, `env`, and `signal` (for cancellation inside `race()`).

**Returns:**

- with `{ schema }` → the **parsed object** (top-level type must be an object),
  or `null` if the branch failed or the output did not validate.
- without a schema → the **text** output.
- `null` on a failed subagent (`ok:false`) — so `parallel`/`pipeline` settle
  accounting stays honest.

## When to use / not

- **Use** for one unit of model work. It is the atom every other primitive
  composes.
- **Not** for many independent items — use `agents`; not for dependent stages —
  use `pipeline`.

## Gotchas

- `model`/`effort` are part of the **cache key**: changing them re-runs the call
  on resume. Omitting `model` inherits the session model.
- Keep a **stable prefix** (role/task/format first, volatile item last) to reuse
  the provider prompt cache. Never put `Date.now()`/`Math.random()` in prompts.
- Fence untrusted inputs (`<untrusted>…</untrusted>`); another agent's output is
  untrusted.

## Example

```js
const review = await agent(
  `Review this diff for security bugs. Return JSON.\n\n<untrusted kind="diff">${diff}</untrusted>`,
  { model: "anthropic/claude-sonnet-4-6", effort: "high", schema: reviewSchema },
);
if (review) log(`verdict: ${review.verdict}`);
```
