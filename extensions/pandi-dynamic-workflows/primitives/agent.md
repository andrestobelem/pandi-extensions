# agent

`agent()` runs **one** subagent call — a single unit of model work with its own
prompt, model/effort budget, and tool access. Reach for it whenever a workflow
step needs "ask a model something and get an answer back," whether that's a
quick classification or a scoped code review.

```js
const review = await agent(
  `Revisá este diff buscando bugs de seguridad. Devolvé JSON.\n\n<untrusted kind="diff">${diff}</untrusted>`,
  { model: "anthropic/claude-sonnet-4-6", effort: "high", schema: reviewSchema },
);
if (review) log(`verdict: ${review.verdict}`);
```

**Runtime:** shared (pi + Claude Code)

**Signature:** `agent(prompt, options?) → Promise<object | string | null>`

The prompt is a string (string-first on Claude). Options set the per-call
budget and access: `model`, `effort` (`low…max`) / `thinking`, `schema`,
`name`/`label`, `agentType` (`explore`/`reviewer`/`planner`/`architect`/
`implementer`/`researcher`), `tools`/`excludeTools`, `skills`, `extensions`,
`keys`, `env`, and `signal` (for cancellation inside `race()`).

**Returns:**

- with `{ schema }` → the **parsed object** (top-level type must be an object).
  If the output does not validate after retries, the default (`schemaOnInvalid:
  "throw"`) is to **throw**, not return `null` — pass `{ schemaOnInvalid: "null" }`
  explicitly to get `null` instead.
- without a schema → the **text** output.
- `null` on a failed subagent (`ok:false`) — so `parallel`/`pipeline` settle
  accounting stays honest.

## When to use / not

| Situation | Use |
| --- | --- |
| One unit of model work | `agent` — the atom every other primitive composes |
| Many independent items | `agents` (fan-out) |
| Dependent stages, output feeds next input | `pipeline` |

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
  `Revisá este diff buscando bugs de seguridad. Devolvé JSON.\n\n<untrusted kind="diff">${diff}</untrusted>`,
  { model: "anthropic/claude-sonnet-4-6", effort: "high", schema: reviewSchema, schemaOnInvalid: "null" },
);
if (review) log(`verdict: ${review.verdict}`);
```
