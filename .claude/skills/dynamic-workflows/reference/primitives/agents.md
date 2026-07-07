# agents

**Runtime:** compartido (pi + Claude Code)

`agents()` ejecuta **el mismo paso**, en paralelo, sobre una lista de items
independientes. Pensalo para casos como «clasificar cada archivo» o «pedirle a
N revisores que miren el mismo diff». Usalo cuando los items no dependan entre
sí y cada uno necesite una sola llamada a subagente.

```js
const results = await agents(
  files.map((f) => ({ prompt: `Clasificá el riesgo de ${f}:\n${readFile(f)}`, name: f })),
  { concurrency: 8, settle: true, model: "haiku", effort: "low" },
);
const ok = results.filter(Boolean);
log(`clasificados ${ok.length}/${files.length} (${files.length - ok.length} fallaron)`);
```

## Firma

`agents(items, options?) → Promise<(SubagentResult | null)[]>`

- `items`: array de strings de prompt o de objetos `AgentSpec`
  (`{ prompt, name, model, effort, … }`).
- `options`: valores por defecto compartidos por llamada (`model`/`effort`/`tools`/…),
  aplicados a todos los items; los campos de un `AgentSpec` individual los
  pisan.
- `options.concurrency`: máximo de llamadas en vuelo, limitado a
  `limits.concurrency`.
- `options.settle`: con `true`, una rama fallida resuelve a `null` en vez de
  rechazar el lote completo.

**Devuelve:** un array alineado con `items`. Cada entrada es un envoltorio
`SubagentResult` (`.output` text, `.data` parsed, `.schemaOk`) o `null` para
una rama fallida cuando `settle: true`.

## Cuándo usarlo

| Situación | Primitiva |
| --- | --- |
| Un paso independiente por item (`scout`, clasificar, extraer por doc) | `agents` |
| 2+ etapas dependientes por item, sin merge entre items | `pipeline` |
| Un paso posterior necesita TODOS los resultados juntos (barrier: dedup, rank, merge) | `parallel` |

## Advertencias

- Incluí un **id/index estable** en cada prompt por item para que dos items no
  compitan por el mismo espacio de caché.
- **Filtrá los `null`** y hacé `log()` de cuántas ramas fallaron; los prompts
  de síntesis deben nombrar ramas fallidas/vacías en vez de ocultarlas.
- `concurrency` por encima de `limits.concurrency` se limita: hacé `log()` de
  ese límite.

## Example

```js
const files = await scanRepo();
const results = await agents(
  files.map((f, i) => ({ prompt: `[${i}] Revisá ${f} por problemas de seguridad`, name: f })),
  { concurrency: 5, settle: true, effort: "medium" },
);
const findings = results.filter(Boolean).map((r) => r.data ?? r.output);
log(`revisados ${findings.length}/${files.length} archivos`);
return await agent(`Resumí los hallazgos:\n${JSON.stringify(findings)}`);
```
