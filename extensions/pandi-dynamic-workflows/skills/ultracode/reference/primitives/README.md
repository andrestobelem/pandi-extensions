# Primitivas de dynamic-workflow (globals inyectados)

Un script de dynamic-workflow es una función JS simple que llama globals ya inyectados: sin `import`/`require` y sin
`ctx.*`. Esta página es el índice: qué hace cada global, cuándo conviene usarlo y dónde está su doc completa.

## Inicio rápido

```js
export default async function main() {
  const findings = await agents(files, { concurrency: 8 }); // un subagente por archivo, 8 a la vez
  return compact(findings.filter(Boolean)); // quitá los `null` (ítems fallidos) y acotá el tamaño de salida
}
// (o un script de nivel superior que termina en `return`)
```

## ¿Qué primitiva usar?

| Necesidad                                                  | Usá                       |
| ---------------------------------------------------------- | ------------------------- |
| Una llamada a subagent                                     | [`agent`](agent.md)       |
| El mismo paso sobre muchos ítems, con concurrencia acotada | [`agents`](agents.md)     |
| Ramas independientes y esperar todas                       | [`parallel`](parallel.md) |
| Etapas dependientes por ítem (sin merge entre ítems)       | [`pipeline`](pipeline.md) |
| Varios intentos; gana el primero bueno                     | [`race`](race.md)         |
| Reusar otro workflow como paso                             | [`workflow`](workflow.md) |

## Todos los globals

| Categoría                    | Primitiva                             | Qué hace                                                                                 |
| ---------------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------- |
| Subagents y composición      | [`agent`](agent.md)                   | Ejecuta un subagent; devuelve objeto parseado con `{ schema }` o texto; `null` si falla. |
| Subagents y composición      | [`agents`](agents.md)                 | `map` paralelo acotado, un paso por ítem (`{ concurrency, settle }`).                    |
| Subagents y composición      | [`parallel`](parallel.md)             | Barrera: corre ramas y espera TODOS los resultados juntos.                               |
| Subagents y composición      | [`pipeline`](pipeline.md)             | Etapas dependientes por ítem, sin merge entre ítems; ítems fallidos → `null`.            |
| Subagents y composición      | [`race`](race.md)                     | Gana el primer valor aceptado; cancela los perdedores en curso.                          |
| Subagents y composición      | [`workflow`](workflow.md)             | Compone un sub-workflow reutilizable inline (con profundidad acotada).                   |
| Humano y observabilidad      | [`ask`](ask.md)                       | Pregunta con human-in-the-loop (`input`/`confirm`/`select`); seguro para reanudar.       |
| Humano y observabilidad      | [`phase`](phase.md)                   | Marca la fase actual para el dashboard/log.                                              |
| Humano y observabilidad      | [`log`](log.md)                       | Agrega una línea al run log.                                                             |
| Filesystem y shell           | [`bash`](bash.md)                     | Ejecuta un comando de shell; el caché es opt-in (`{ cache: true }`).                     |
| Filesystem y shell           | [`readFile`](readFile.md)             | Lee un archivo relativo al `cwd`.                                                        |
| Filesystem y shell           | [`writeFile`](writeFile.md)           | Escribe un archivo (crea parent dirs).                                                   |
| Filesystem y shell           | [`appendFile`](appendFile.md)         | Agrega contenido a un archivo (crea parent dirs).                                        |
| Filesystem y shell           | [`listFiles`](listFiles.md)           | Lista archivos recursivamente (omite `node_modules`/`.git`).                             |
| Artifacts                    | [`writeArtifact`](writeArtifact.md)   | Escribe un artifact de run con nombre.                                                   |
| Artifacts                    | [`appendArtifact`](appendArtifact.md) | Agrega contenido a un artifact con nombre (seguro con concurrencia).                     |
| Utilidades                   | [`sleep`](sleep.md)                   | Demora abortable.                                                                        |
| Utilidades                   | [`json`](json.md)                     | `stringify` seguro y acotado.                                                            |
| Utilidades                   | [`compact`](compact.md)               | `stringify` acotado para prompts.                                                        |
| Utilidades                   | [`args`](args.md)                     | El input del workflow.                                                                   |
| Contexto de run solo lectura | [`limits`](limits.md)                 | Límites `{ concurrency, maxAgents, … }`.                                                 |
| Contexto de run solo lectura | [`runId`](runId.md)                   | El id de este run.                                                                       |
| Contexto de run solo lectura | [`runDir`](runDir.md)                 | El directorio de este run (acá viven los artifacts).                                     |
| Contexto de run solo lectura | [`cwd`](cwd.md)                       | El working directory del workflow.                                                       |

## Cómo funciona

La fuente de verdad de _qué_ primitivas existen son las asignaciones `sandbox.<name> = …` en `worker-source.ts`. Un test
de paridad (`tests/integration/primitives-parity.test.mjs`) mantiene esta carpeta 1:1 con esa lista: si agregás o quitás
un global ahí, el test falla hasta que agregues o quites acá el `<name>.md` correspondiente. Esta carpeta es el análogo
por primitiva de `scaffolds/` para patrones.

## Cosas a tener en cuenta

- **Entre runtimes:** solo el núcleo (`agent`, `agents`, `parallel`, `pipeline`, `workflow`, `phase`, `log`, `args`,
  `compact`) se comparte con la herramienta Claude Code Workflow; no asumas que el resto existe ahí.
- Las primitivas de **filesystem/shell** (`bash`, `readFile`, `writeFile`, `appendFile`, `listFiles`) quedan confinadas
  al `cwd` del run.
- Los **artifacts** se persisten bajo `runDir` y siguen siendo inspeccionables cuando el run termina.
- **Forma de falla:** `agent`/`agents` devuelven `null` por cada ítem fallido en vez de hacer throw; filtrá siempre
  antes de usar resultados (ver la línea `compact(findings.filter(Boolean))` de arriba).

## Relacionado

Estos globals los provee la extensión `@pandi-coding-agent/pandi-dynamic-workflows`. Para instalación y la superficie
completa de la extensión, mirá [`extensions/pandi-dynamic-workflows/README.md`](../README.md).
