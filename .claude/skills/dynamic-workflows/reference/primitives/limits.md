# limits

`limits` expone los topes efectivos del run (`concurrency`, budgets, `timeouts`) como una global congelada y de solo
lectura. Sirve para que un workflow ajuste su propio fan-out a lo que el run permite de verdad, en vez de adivinar o
hardcodear números. Usalo cuando estés por lanzar N subagentes y necesites saber cuántos pueden correr a la vez.

```js
const want = files.length;
const conc = Math.min(want, limits.concurrency);
if (conc < want) log(`clamping concurrency ${want} → ${conc} (limits.concurrency)`);
const results = await agents(files, { concurrency: conc, settle: true });
```

**Runtime:** pi runtime (read-only run context)

**Signature:** `limits` (frozen object) — `{ concurrency, maxAgents, timeoutMs, agentTimeoutMs, syncTimeoutMs }`

- `concurrency`: máximo de subagentes en vuelo.
- `maxAgents`: budget total de agentes para el run.
- `timeoutMs`: timeout total del run.
- `agentTimeoutMs`: timeout por llamada de agente.
- `syncTimeoutMs`: timeout de la ejecución sincrónica del script de nivel superior.

## Devuelve

Devuelve un objeto de topes (ver arriba), congelado: reasignar campos o mutarlos no hace nada o lanza bajo strict mode.

## Cuándo usarlo y cuándo no

| Situación                                   | Hacé esto                                                                     |
| ------------------------------------------- | ----------------------------------------------------------------------------- |
| Ajustar fan-out al budget del run           | `Math.min(desired, limits.concurrency)`                                       |
| Decidir cuántas ramas lanzar                | Verificá `limits.maxAgents`                                                   |
| Llamar `agents()`/`parallel()`/`pipeline()` | No hace falta clamp manual: ya ajustan `concurrency` a `limits.concurrency`   |
| Intentar subir el tope en runtime           | No: `limits` está congelado; los topes vienen del tool call que inició el run |

## Cosas a tener en cuenta

- Aunque sea read-only (`frozen`), ajustar el _total agent count_ contra `maxAgents` sigue siendo tu responsabilidad:
  nada lo aplica automáticamente.
- **Logueá cualquier clamp** que apliques para que el tope quede inspeccionable en los run artifacts.

## Example

```js
export default async function main(ctx, input) {
  const files = input.files ?? [];
  const conc = Math.min(files.length, limits.concurrency);
  log(`fanning out over ${files.length} files at concurrency ${conc}`);
  const results = await agents(
    files.map((f) => `Revisá ${f} buscando bugs`),
    { concurrency: conc, settle: true },
  );
  return results;
}
```
