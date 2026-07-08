# pipeline

**Runtime:** compartido (pi + Claude Code)

`pipeline` hace pasar cada item por la **misma secuencia de etapas
dependientes**, una cadena propia por item, sin merge entre items. Usalo
cuando la tarea se vea como «para cada item: paso 1, después paso 2,
después paso 3» (por ejemplo, classify → deep-review → summarize).

```js
const summaries = await pipeline(
  files,
  (f) => agent(`Clasificá el riesgo de ${f}`, { model: "haiku", effort: "low", name: `classify:${f}` }),
  (risk, f) => agent(`Dado el riesgo ${risk}, hacé deep-review de ${f}`, { model: "sonnet", effort: "high", name: `review:${f}` }),
);
log(`revisados ${summaries.filter(Boolean).length}/${files.length}`);
```

## Firma

`pipeline(items, ...stages, [options]) → Promise<(result | null)[]>`

Cada etapa se llama como `stage(value, originalItem, index)`:

- `value`: salida de la etapa anterior para ese item; en la primera etapa es
  el item crudo.
- `originalItem` / `index`: siempre son el item original intacto y su
  posición. Sirven para ids estables en prompts incluso al fondo de la
  cadena.

Los items corren en paralelo hasta el límite `concurrency` del workflow. Para
bajarlo solo en esta llamada, pasá `{ inFlight: n }` como objeto de options al
final. Máximo 4096 items por llamada; si tenés una work-list más grande,
partila vos.

**Devuelve:** un array alineado con `items`. Cada entrada es la salida de la
última etapa para ese item, o `null` si alguna etapa lanzó para ese item; un
item fallido nunca hunde el lote.

## Cuándo usarlo

| Situación | Primitiva |
| --- | --- |
| Mismas N etapas dependientes por item, con items independientes | `pipeline` (predeterminada para trabajo multi-stage por item) |
| Un solo paso por item | `agents` |
| Un paso posterior necesita TODOS los items juntos (por ejemplo, rank o dedupe global) | `parallel` |
| N enfoques alternativos para el mismo item y querés quedarte con el primero que salga bien | `race` |

## Cosas a tener en cuenta

- Meté un **id/index estable del item** en los prompts generados dentro de las
  etapas: usá `originalItem` / `index`, no solo el `value` que va corriendo
  por la cadena (corrección de caché + reanudación).
- Los items fallidos vuelven como `null`, no se lanzan. Hacé
  `filter(Boolean)` y `log()` del conteo antes de cualquier combinación final, o una
  caída silenciosa puede parecer éxito.
- `{ inFlight }` solo baja la concurrencia de esta llamada; nunca puede pasar
  el `limits.concurrency` del workflow.

## Ejemplo

```js
export default async function main() {
  const files = ["src/a.ts", "src/b.ts", "src/c.ts"];
  const results = await pipeline(
    files,
    (f) => agent(`Clasificá el riesgo de ${f}`, { model: "haiku", effort: "low" }),
    (risk, f, i) => agent(`Dado el riesgo ${risk}, hacé deep-review de ${f} (#${i})`, { model: "sonnet", effort: "high" }),
    { inFlight: 3 },
  );
  const ok = results.filter(Boolean);
  log(`revisados ${ok.length}/${files.length}`);
  return ok;
}
```
