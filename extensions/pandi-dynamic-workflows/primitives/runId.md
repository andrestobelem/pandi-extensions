# runId

`runId` es el id único de la ejecución actual del workflow, inyectado como string global de solo lectura. Usalo para
etiquetar logs, artifacts o mensajes para que una persona humana —u otra herramienta— pueda encontrar esta ejecución
exacta más tarde, por ejemplo con `/workflow view <runId>` o `resume`.

```js
log(`starting run ${runId}`);
await writeArtifact("meta.json", { runId });
```

**Runtime:** runtime de pi (contexto de ejecución de solo lectura)

**Firma:** `runId` (string) — id de esta ejecución

**Devuelve:** el string del id de ejecución.

## Cuándo usarlo y cuándo no

- **Usalo** para correlacionar logs o artifacts con la ejecución, o para referenciarla en mensajes
  (`/workflow view <runId>`, `resume`).
- **No lo uses** en prompts ni en cache keys como token variable: cambia en cada ejecución y rompería el prompt cache.

## Cosas a tener en cuenta

- Es de solo lectura. Preferí artifacts bajo `runDir` antes que incrustar `runId` en el contenido.

## Example

```js
export default async function main() {
  log(`starting run ${runId}`);
  const result = await agent("summarize the target repo", { model: "sonnet" });
  await writeArtifact("summary.json", { runId, result });
  return `run ${runId} complete`;
}
```
