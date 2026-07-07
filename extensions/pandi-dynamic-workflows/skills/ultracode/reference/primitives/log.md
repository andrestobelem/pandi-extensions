# log

`log()` escribe una línea en el registro de eventos de la corrida: la misma
línea de tiempo que ves en `/workflow view` y en el dashboard. Usalo para que,
al inspeccionar la corrida más tarde, cualquiera pueda entender qué pasó sin
volver a ejecutarla.

```js
const results = await agents(items, { concurrency: 8, settle: true });
const failed = results.filter((r) => r == null).length;
log(`fan-out: ${results.length - failed}/${results.length} ok, ${failed} failed`);
```

**Runtime:** shared (pi + Claude Code)

**Signature:** `log(...args) → void`

Los argumentos que no son string se compactan antes de unirse en una sola
línea.

## Qué devuelve

Nada.

## Cuándo usarlo

| Situación | Usá `log` |
| --- | --- |
| Reportar resultados de scout, resultados de ramas, resúmenes de `fan-out` | Sí |
| Registrar un cap/clamp/skip (`slice`, top-N, sampling, límite de concurrency) | Sí — siempre |
| Devolver el resultado del workflow | No — usá el valor de `return`, no `log` |
| Ruido por token o por chunk | No — una línea por evento con significado |

## Cosas a tener en cuenta

- **Nunca limites cobertura en silencio.** Todo `slice`/top-N/sampling/no-retry o concurrency clamp debe quedar en `log()` para que el límite sea inspeccionable después.
- Preferí una línea clara por evento con significado antes que logging ruidoso por token.
- `log` es solo observabilidad: no afecta el control flow ni el valor de retorno.

## Example

```js
export default async function main() {
  const items = ["a", "b", "c"];
  const results = await agents(items, { concurrency: 4, settle: true });
  const failed = results.filter((r) => r == null).length;
  log(`fan-out: ${results.length - failed}/${results.length} ok, ${failed} failed`);
  return results;
}
```
