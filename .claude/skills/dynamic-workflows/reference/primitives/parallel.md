# parallel

`parallel()` abre en paralelo una **lista fija y chica de ramas** y espera a
**todas** antes de correr el paso siguiente: actúa como una barrera. Usalo
cuando un paso realmente necesita todos los resultados juntos (merge, dedup,
rank), no solo para “correr varias cosas a la vez”.

```js
const [byGrep, bySemantic, byTests] = await parallel([
  () => agent(`Find auth bugs by grep:\n${grepHits}`),
  () => agent(`Find auth bugs by reading the flow:\n${flow}`),
  () => agent(`Find auth bugs implied by failing tests:\n${testLog}`),
]);
const merged = dedupe([byGrep, bySemantic, byTests].filter(Boolean));
```

**Runtime:** compartido (pi + Claude Code)

**Signature:** `parallel(thunks) → Promise<results[]>`

- `thunks`: arreglo de funciones sin argumentos; cada una devuelve una promise
  y normalmente envuelve una o más llamadas a `agent()`.
- La concurrencia se limita sola a `limits.concurrency`: no hay un argumento
  de opciones para configurarla.

## Devuelve

Un arreglo de resultados alineado con `thunks`. Si una rama lanza una
excepción, se resuelve como `null` en vez de rechazar el lote completo; así,
una falla no hunde a las demás.

## Cuándo usarlo y cuándo no

| Situación | Primitive |
| --- | --- |
| Un paso posterior necesita TODOS los resultados de las ramas a la vez (merge, dedup, rank, early-exit sobre el total combinado) | `parallel` |
| El mismo paso sobre una lista de ítems independientes | `agents` |
| 2+ etapas dependientes por ítem, sin merge entre ramas | `pipeline` |

Prueba de olor: `parallel → transform-with-no-cross-item-dependency → parallel`
debería ser UN solo `pipeline`. `map`/`filter`/formateo, por sí solos, nunca
justifican una barrera.

## Cosas a tener en cuenta

- Filtrá los `null` antes de hacer merge y registrá con `log()` cuántas ramas
  fallaron.
- Preferí `pipeline` salvo que un paso posterior realmente necesite TODOS los
  resultados juntos.
- `thunks` es una lista fija de ramas, no un map por ítem: para N ítems, usá
  `agents`.

## Example

```js
const [grepFindings, semanticFindings] = await parallel([
  () => agent(`Find auth bugs by grep:\n${grepHits}`),
  () => agent(`Find auth bugs by reading the flow:\n${flow}`),
]);
const findings = [grepFindings, semanticFindings].filter(Boolean);
log(`parallel: ${findings.length}/2 branches succeeded`);
const report = await agent(`Merge and dedupe these findings:\n${JSON.stringify(findings)}`);
return report;
```
