# workflow

`workflow()` deja que un script de workflow llame a otro workflow guardado por nombre y reciba su valor de retorno, sin
un gate de decisión humana entre medio. Usalo para reutilizar un scaffold — por ejemplo, un verificador `*-lib` — en vez
de reimplementarlo inline.

```js
// dentro de un workflow driver
const verified = await workflow("verify-claims-lib", { claims, evidence });
return verified.filter((c) => c.status === "confirmed");
```

**Runtime:** compartido (pi + Claude Code)

**Firma:** `workflow(name, args) → Promise<result>`

**Devuelve:** el valor que retorna el sub-workflow.

## Cuándo usarlo

| Situación                                                                | Hacé esto                                                                        |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| Subpaso reutilizable, sin necesidad de decidir según su resultado        | `workflow("name", args)`                                                         |
| Necesitás inspeccionar el subresultado antes de elegir la siguiente fase | corré workflows separados en secuencia                                           |
| El paso reutilizable necesita llamar a otro sub-workflow                 | no está soportado: aplanalo o convertí ese paso en un workflow top-level hermano |

## Ojo con esto

- **La composición es depth-1, estrictamente.** Si un sub-workflow llama a `workflow()`, lanza
  `"workflow() composition depth limit is 1: sub-workflows cannot call other sub-workflows."`. Solo el workflow
  top-level puede componer. Esto vale igual en pi y en Claude Code (comparten runtime).
- **No podés llamar tu propio archivo.** Si un workflow resuelve al mismo archivo que el actual, lanza
  (`refused recursive call`). No hay self-recursion vía `workflow()`.
- No lo confundas con `PI_DYNAMIC_WORKFLOWS_MAX_DEPTH` (solo pi, por defecto 2): eso protege _nested top-level runs_
  iniciados por el tool `dynamic_workflow` de un subagente. Es un mecanismo distinto de la composición con `workflow()`.
- Declará la procedencia: seteá `meta.basedOn` (array de `{ name, role }`) en cada scaffold que compongas.

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
