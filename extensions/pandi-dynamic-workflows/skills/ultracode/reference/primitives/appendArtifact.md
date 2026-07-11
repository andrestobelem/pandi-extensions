# appendArtifact

Agrega texto o bytes a un artifact compartido del run, de forma segura incluso si muchos agentes concurrentes escriben
al mismo tiempo. Usalo cuando querés un solo `findings.log` o `trace.jsonl` al que cada rama de un fan-out con
`parallel` o `agents` le agregue una línea al terminar.

```js
const results = await agents(items, { concurrency: 8, settle: true });
for (const [i, r] of results.entries()) {
  if (r) await appendArtifact("findings.log", `#${i}: ${r.output}\n`);
}
```

**Runtime:** pi runtime

**Firma:** `appendArtifact(name, data) → Promise<{ path }>`

Agrega contenido a un artifact nombrado bajo el `runDir` del run. `data` puede ser un string o un `Uint8Array`. Las
escrituras se **serializan por path** (mediante un mutex interno por archivo resuelto), así que varios agentes que
appenden al mismo artifact no intercalan una escritura parcial ni corrompen el archivo. Emite un evento
`artifact_append`.

**Devuelve:** `{ path }` — el path absoluto del artifact.

## Cuándo usarlo

- **Sí**: para transmitir un log o artifact compartido del run desde muchas ramas concurrentes; por ejemplo, cuando cada
  agente agrega su línea de hallazgo.
- **No**: para archivos en `cwd` (usá [`appendFile`](appendFile.md)) ni para escrituras de una sola vez (usá
  [`writeArtifact`](writeArtifact.md)).

## Detalles a tener en cuenta

- Es seguro ante concurrencia por diseño gracias al mutex por path; por eso conviene más que `appendFile` cuando hay
  agregadores en paralelo.
- Vive en el alcance del run (`runDir`) y se puede inspeccionar en el dashboard.

## Example

```js
const items = ["a.ts", "b.ts", "c.ts"];
const agentSpecs = items.map((item) => ({
  prompt: `Revisá ${item} y devolvé el hallazgo principal.`,
  model: "sonnet",
}));
const results = await agents(agentSpecs, { concurrency: 3, settle: true });
for (const [i, r] of results.entries()) {
  if (r) await appendArtifact("review.log", `${items[i]}: ${r.output}\n`);
}
return { done: results.filter(Boolean).length };
```
