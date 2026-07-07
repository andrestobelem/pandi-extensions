# agent

`agent()` ejecuta **una** llamada de subagente: una unidad puntual de trabajo de modelo con su propio prompt, presupuesto de `model`/`effort` y acceso a tools. Usalo cuando un paso del workflow necesite “pedirle algo a un modelo y recibir una respuesta”, ya sea una clasificación rápida o una code review acotada.

```js
const review = await agent(
  `Revisá este diff buscando bugs de seguridad. Devolvé JSON.\n\n<untrusted kind="diff">${diff}</untrusted>`,
  { model: "anthropic/claude-sonnet-4-6", effort: "high", schema: reviewSchema },
);
if (review) log(`verdict: ${review.verdict}`);
```

**Runtime:** shared (pi + Claude Code)

**Signature:** `agent(prompt, options?) → Promise<object | string | null>`

El prompt es un string (`string-first` en Claude). `options` define el presupuesto y el acceso de esa llamada: `model`, `effort` (`low…max`) / `thinking`, `schema`, `name`/`label`, `agentType` (`explore`/`reviewer`/`planner`/`architect`/`implementer`/`researcher`), `tools`/`excludeTools`, `skills`, `extensions`, `keys`, `env` y `signal` (para cancelación dentro de `race()`).

## Qué devuelve

- con `{ schema }` → el **objeto parseado** (el tipo de nivel superior debe ser un objeto). Si la salida no valida después de los retries, el valor por defecto (`schemaOnInvalid: "throw"`) es hacer **throw**, no devolver `null`; pasá `{ schemaOnInvalid: "null" }` explícitamente si querés `null`.
- sin `schema` → la salida de **texto**.
- `null` cuando falla el subagente (`ok:false`), para que el settle accounting de `parallel`/`pipeline` siga siendo honesto.

## Cuándo usarlo

| Situación | Usá |
| --- | --- |
| Una unidad de trabajo de modelo | `agent`: el átomo que componen las demás primitivas |
| Muchos ítems independientes | `agents` (`fan-out`) |
| Etapas dependientes, donde una salida alimenta la siguiente entrada | `pipeline` |

## Cosas a tener en cuenta

- `model`/`effort` forman parte de la **cache key**: cambiarlos vuelve a ejecutar la llamada al reanudar. Si omitís `model`, hereda el modelo de la sesión.
- Conservá un **stable prefix** (rol/tarea/formato primero, ítem volátil al final) para reutilizar la prompt cache del provider. Nunca pongas `Date.now()`/`Math.random()` en prompts.
- Encerrá inputs no confiables (`<untrusted>…</untrusted>`); la salida de otro agente también es no confiable.

## Example

```js
const review = await agent(
  `Revisá este diff buscando bugs de seguridad. Devolvé JSON.\n\n<untrusted kind="diff">${diff}</untrusted>`,
  { model: "anthropic/claude-sonnet-4-6", effort: "high", schema: reviewSchema, schemaOnInvalid: "null" },
);
if (review) log(`verdict: ${review.verdict}`);
```
