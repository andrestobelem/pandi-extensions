# phase

`phase(label)` agrega una etiqueta persistente para indicar en qué etapa está la corrida en este momento. Es solo para
personas que miran el dashboard/logs: no influye en la lógica del workflow.

Usalo cuando una corrida tenga más de una etapa visible y quieras que el log/dashboard se lea como una historia, no como
una lista plana de llamadas.

```js
phase("scout");
const files = await agent("List high-risk files", { model: "haiku" });
phase("fan-out");
const findings = await agents(files, { concurrency: 8 });
phase("synthesize");
return await agent(`Synthesize:\n${compact(findings)}`, { effort: "high" });
```

**Runtime:** compartido (pi + Claude Code)

**Signature:** `phase(label) → void`

Escribe `phase: <label>` en el log y agrupa la actividad siguiente bajo esa etiqueta en el dashboard/live view hasta la
próxima llamada a `phase()`. Si usás `phase(null)`, limpia la etiqueta actual y no escribe nada en el log.

**Returns:** nada.

## Cuándo usarlo y cuándo no

| Situación                                                   | ¿Usar `phase()`?                                                     |
| ----------------------------------------------------------- | -------------------------------------------------------------------- |
| Corrida con varias etapas (scout → fan-out → synthesize)    | Sí — etiqueta la historia para quien lee                             |
| Una sola llamada a `agent()`                                | No — no hay nada para etiquetar                                      |
| Necesitás ramificar el comportamiento según la etapa actual | No — es solo observabilidad; no es estado para leer de vuelta        |
| Necesitás gatear o esperar a que una etapa termine          | No — usá `await`/`pipeline()`; `phase()` no cambia el comportamiento |

## Cosas a tener en cuenta

- Es solo cosmético: nunca gatea, espera ni bloquea nada. Un workflow con cero llamadas a `phase()` se comporta igual,
  solo con un log más plano.
- Las etiquetas aparecen verbatim en el log/dashboard; mantenelas cortas, estables y legibles para humanos (`"fan-out"`,
  no un porcentaje cambiante).
- `phase(null)` limpia la etiqueta sin emitir una línea de log. Usalo entre etapas no relacionadas si no querés que
  quede colgando la etiqueta anterior.

## Example

```js
export default async function main() {
  phase("scout");
  const files = await agent("List high-risk files", { model: "haiku" });
  phase("fan-out");
  const findings = await agents(files, { concurrency: 8 });
  phase("synthesize");
  const summary = await agent(`Synthesize:\n${compact(findings)}`, { effort: "high" });
  phase(null);
  return summary;
}
```
