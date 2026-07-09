# @pandi-coding-agent/pandi-dynamic-workflows

Un runtime de JavaScript para workflows multiagente dentro de Pi: lanza subagentes en paralelo, junta artifacts, reanuda corridas interrumpidas y muestra todo en un dashboard TUI. Sirve cuando una tarea es demasiado grande o incierta para una sola respuesta — por ejemplo, una auditoría repo-wide, una migración amplia o una investigación con perspectivas independientes — y sobra para una pregunta simple o una edición de un solo archivo.

## Inicio rápido

Un workflow es un archivo JavaScript plano: un script top-level (sin `import`, sin otros exports) que termina con `return <value>` y usa globals inyectados como `agent` y `args`. Guardá esto como `.pi/workflows/hello.js`:

```js
const input = typeof args === "string" ? JSON.parse(args) : (args ?? {});
const topic = input.topic ?? "pi extensions";
const notes = await agent(`List 3 facts about ${topic}.`, { model: "haiku", effort: "low" });
return await agent(`Turn these notes into one tight paragraph:\n${notes}`, { effort: "high" });
```

Después, desde una sesión de Pi:

```text
/workflow check hello {"topic": "circuit breakers"}
/workflow run hello {"topic": "circuit breakers"}
```

Ese es el loop completo: escribí un archivo `.js`, validalo opcionalmente con `/workflow check` y luego corré `/workflow run <name> [json-input]`.
¿Sin UI? Pedile al agente que llame la tool `dynamic_workflow` con
`action: "write"` (name + code) y `action: "run"` (name + input).

## Qué te llevás

- Un runtime de workflows JavaScript con globals inyectados: `agent`, `agents`, `pipeline`, `parallel`, `race`, `ask`, `workflow`, `phase`, `log`, `args`, más `limits`/`runId`/`runDir`/`cwd` de solo lectura.
- La tool de modelo `dynamic_workflow` para listar, scaffoldear, leer, validar, escribir, correr, reanudar, cancelar, borrar, graficar, listar runs y ver workflows (entre otras cosas).
- Un journal reanudable y artifacts por run, para que una corrida caída o cancelada continúe en vez de reiniciarse.
- Un dashboard TUI en vivo (`/workflows` o `Ctrl+Alt+W`) con tabs Monitor, Agents, Sessions, Runs, Workflows, Patterns y Activity.
- Comandos de routing Ultracode y un Contract Gate que revisa el contrato de la tarea antes de orquestar en grande.
- Un catálogo compacto de scaffolds: 12 primarios, 7 de composición y 6 orientados a casos de uso, sin aliases de patterns.

## Instalar

Desde npm:

```bash
pi install npm:@pandi-coding-agent/pandi-dynamic-workflows
```

Desde este repositorio:

```bash
pi install ./extensions/pandi-dynamic-workflows          # global (tu usuario)
pi install -l ./extensions/pandi-dynamic-workflows       # local al proyecto
pi --no-extensions -e ./extensions/pandi-dynamic-workflows   # prueba puntual, sin cargar nada más
```

### Contract Gate incluido

El paquete incluye el workflow ejecutable read-only `contract-gate`. `dynamic_workflow` lo resuelve
como fallback global desde cualquier proyecto donde la extensión esté instalada, después de los
workflows del proyecto y del agent-dir de la persona. No copia ni modifica
`~/.pi/agent/workflows/` al cargar la extensión.

El nombre también existe en el catálogo de **scaffolds**, pero es otra superficie: usá
`action: "run"` o `action: "start"` para ejecutar el Contract Gate incluido, y
`action: "scaffold"` para leer el patrón y crear un workflow propio. Un workflow bundled es
read-only y no se puede borrar mediante `/workflow delete`.

## Cómo elegir un primitive

| Situación | Primitive |
| --- | --- |
| Una llamada a subagente | `agent(prompt, options?)` |
| El mismo paso, sobre muchos ítems independientes | `agents(items, options?)` |
| 2+ etapas dependientes por ítem, sin merge entre ítems | `pipeline(items, ...stages)` |
| Un paso posterior necesita TODOS los resultados juntos (barrera: dedupe, rank, merge) | `parallel(thunks)` |
| Gana la primera respuesta aceptada; se cancela el resto | `race(thunks, { accept? })` |
| El workflow no puede decidir solo de forma segura y necesita una persona | `ask(question, options?)` |

`race` y `ask` son exclusivos de pi (no existen en la Claude Code Workflow tool). Mirá `primitives/*.md` para firmas completas y gotchas.

## Comandos

| Comando | Qué hace |
| --- | --- |
| `/workflow …` | Administra workflows: `new` (scaffold), `check`, `run`, `start`, `agents`, `sessions`, `cleanup`, `delete`, `delete-run` y más. |
| `/workflows` | Abre el dashboard de workflows (también `Ctrl+Alt+W`). |
| `/dynamic-workflow` (alias `/ultracode`) | Enruta la tarea actual por el router de workflows de Ultracode. |
| `/deep-research` | Intent legacy; enruta al pattern `complex-research`. |
| `/ultracode-mode` | Activa o desactiva el routing Ultracode always-on para la sesión. |
| `/ultracode-contract` | Activa o desactiva el Contract Gate; `/ultracode-contract off` lo apaga para la sesión. |
| `dynamic_workflow` | Tool de modelo: lista, scaffoldea, lee, valida, escribe, corre, inicia, reanuda, cancela, borra, grafica, lista runs, ve y reporta workflows (entre otras cosas). |

`/workflow cleanup` está pensado para dry-run y pertenece a esta extensión: `sessions` poda heartbeats viejos, `runs` elimina directorios terminales manteniendo historial reciente, `drafts` borra drafts viejos sin uso y `tmp` limpia entradas antiguas de `.pi/tmp`. Usá `--dry-run` para ver cada decisión `delete`/`keep` con su razón; la limpieza destructiva requiere confirmación en UI o `--yes` en modo headless. `both` conserva el default legacy (`sessions+runs`) y `all` suma `drafts` y `tmp`.

`/workflow check <name> [json-input]` valida la fuente del workflow y su input sin crear un run. `/workflow run <name>` corre en foreground e imprime el resultado, salvo dentro de una sesión persistente (TUI), donde pasa automáticamente a background para que el dashboard siga siendo el plano de control. `/workflow start <name>` lanza en background cuando la sesión es TUI o RPC, así podés seguir chateando mientras corre; en modo print/json no existe una sesión persistente que lo mantenga vivo, así que falla en vez de degradarse a foreground.

En `/reload`, los workflows activos en background se interrumpen y se reanudan automáticamente en la instancia nueva de la extensión con el mismo `runId` y los límites originales (`concurrency`, `maxAgents`, timeouts). Las llamadas ya journaled siguen cacheadas; las que estaban en vuelo y los efectos laterales no cacheados pueden ejecutarse otra vez, igual que con `/workflow resume`.

## Cómo funciona

Los workflows estables viven en `.pi/workflows/`; los drafts y artifacts de runs viven en `.pi/workflows/drafts/` y `.pi/workflows/runs/` dentro de proyectos confiables. Un workflow puede declarar opcionalmente `export const meta = { name, description, phases }` para etiquetas del dashboard. Algunos primitives clave, además de la tabla de arriba:

- `ask(question, opts?)` — pausa una rama para preguntarle a una persona vía la UI de Pi (`input`/`confirm`/`select`). Es seguro al reanudar (la respuesta queda journaled y se reproduce, nunca se vuelve a preguntar), honesto en modo headless (`opts.default` o error claro, nunca cuelga) y cancelable dentro de `race()`.
- `race(thunks, { accept? })` — gana la primera rama aceptada; los perdedores en vuelo se cancelan con un SIGTERM real vía el `AbortSignal` de cada thunk. Devuelve `{ winner, index, status }`.
- **Modelo y razonamiento por llamada:** cada subagente puede fijar su propio `model`, `provider` y `effort` (`low|medium|high|xhigh|max`). Si los omitís, heredan el modelo del orquestador y el reasoning level de la sesión. Forman parte de la cache key, así que cambiarlos reejecuta esa llamada al reanudar.

```js
// Elegí modelo + razonamiento por llamada.
const notes = await agents(files.map((f) => ({
  label: `scout-${f}`, prompt: `Summarize risks in ${f}.`,
  model: "haiku", effort: "low", tools: ["read", "grep", "find", "ls"],
})), { concurrency: 8 });
const verdict = await agent(
  `Synthesize a ranked, evidence-backed verdict.\n\n${compact(notes, 50000)}`,
  { label: "synthesis", model: "sonnet", effort: "high" },
);
```

Reglas de diseño de prompts incorporadas en los scaffolds:

- **Prefijo estable para KV-cache.** Poné primero el framing compartido (rol, tarea, criterios de éxito, formato de salida) y dejá al final el contenido volátil por ítem, para que los prefijos idénticos reutilicen la prompt/KV cache del provider. Evitá `Date.now()`/`Math.random()` dentro de prompts: rompen esa cache y hacen fallar el journal de resume, reejecutando la llamada.
- **Síntesis consciente de la posición.** Los modelos atienden mejor al principio y al final del contexto y peor al medio (la curva en U de *lost in the middle*; ver `docs/research/2026-06-28-context-engineering-focus.md`). Los scaffolds de síntesis reafirman la tarea y los criterios DESPUÉS del bloque de evidencia, con un cierre corto que pide formato de salida, orden por importancia y notas explícitas sobre ramas fallidas o vacías. Repetí este patrón en tus workflows: tarea/criterios en ambos extremos, evidencia en el medio.

Cuando el routing always-on está activo, el borde superior del prompt incrusta la etiqueta `ultracode auto` (solo color del borde, siempre plain borders, para no tocar hints como `↑ N more`), y la línea de estado muestra `uc:auto`/`uc:off` para el routing y `cg:on`/`cg:off` para el Contract Gate.

## Limitaciones y notas de seguridad

El runtime limita la ejecución en varias capas para que un workflow no crezca sin control:

- **`maxAgents`** — tope de subagentes por run (en todas las fases, no solo el pico de paralelismo); se clampa a `limits.maxAgents`.
- **`concurrency`** — subagentes simultáneos; se clampa a `limits.concurrency`.
- **Composición depth-1** — `workflow(name, args)` invoca sub-workflows reutilizables con un solo nivel de profundidad; las llamadas recursivas más profundas se rechazan.
- **Guard de recursión cross-process** — cada subagente se lanza un nivel más profundo (`PI_DYNAMIC_WORKFLOWS_DEPTH` = depth + 1). Si un subagente con `includeExtensions: true` tiene la tool `dynamic_workflow`, sus acciones `start`/`run`/`resume` se **rechazan** cuando la profundidad llega al límite. Así se cierra el vector en el que un subagente dispararía runs top-level anidados que no cuentan contra el presupuesto del padre.
- Los runs todavía pueden ejecutarse en proyectos no confiables, pero sus artifacts se redirigen a una raíz global hasheada por proyecto en vez de `.pi/workflows/runs/`. Solo escribir drafts/workflows con `scope=project` requiere un **trusted project** (usá `scope=global` para escribir sin trust).

## Detalles

### Variables de entorno

| Variable | Significado |
| --- | --- |
| `PI_DYNAMIC_WORKFLOWS_DEPTH` | Profundidad de anidamiento de la sesión actual (`0` en el Pi top-level). La setea el runtime al lanzar cada subagente; nunca la definís a mano. |
| `PI_DYNAMIC_WORKFLOWS_MAX_DEPTH` | Límite a partir del cual `start`/`run`/`resume` se rechaza (default **`2`**, permite hasta dos niveles de anidamiento). Subilo para permitir más nesting; **`0` deshabilita todos los runs** (incluidos los top-level), útil como kill-switch. |

### Monitor y dashboard

Abrí el dashboard con `/workflows` o `Ctrl+Alt+W`. Desde un editor **vacío**, `↓` abre Monitor y `←` abre Sessions (si ya hay un prompt escrito, `↓`/`←` vuelven a ser movimiento normal del cursor). `/workflow agents` y `/workflow sessions` abren esas tabs directamente, y la línea de estado idle muestra `wf · /workflows` como punto de entrada.

Resumen de teclado (`?` abre la ayuda completa):

- **Tabs:** `Tab`/`→` siguiente, `Shift+Tab`/`←` anterior; saltos directos `m` Monitor · `A`/`n` Agents · `a` Activity · `s` Sessions · `w` Workflows · `p` Patterns · `R` Runs.
- **Listas:** `↑`/`↓` o `k`/`j`; `PgUp`/`PgDn` página; `Home`/`End` o `G` primero/último.
- **Acciones:** `Enter`/`o` detalle de agente — una pantalla con sub-tabs (**Card · Prompt · Graph · Output · Definition · Run**; cambiá con `←`/`→`, `Tab` o `1`–`6`, y el scroll se recuerda por tab) · `v` ver run · `g` graph · `c`/`x` cancelar run activo · `r` rerun · `d`/`Del` borrar run (con confirmación). En **Agents**, `f` salta al próximo agente `failed`.
- **Monitor:** con varios runs activos, `[` y `]` cambian el run enfocado (`Active runs (N)` arriba y un título `run k/N`). El encabezado muestra `actualizado hace Ns` en cada refresh, o `⚠ falló el refresh: …` si falla.
- **Live agent viewer:** `↑↓`/`PgUp`/`PgDn`/`Home`/`End` para scroll; el encabezado muestra `refresh 1s` mientras corre y `final (<state>)` al terminar (ahí se detiene el polling). `q`/`Esc` cierra.

La ayuda superior solo anuncia acciones válidas para el run seleccionado (por ejemplo, no muestra `cancel` cuando el run no está activo). Las acciones destructivas (cancelar, borrar, rerun, cambiar de sesión) piden confirmación.

### Catálogo de scaffolds

Antes de escribir un workflow, usá `dynamic_workflow action=scaffold` o `/workflow new <name> --pattern=<key>` para inspeccionar el scaffold más cercano. Los scaffolds son piezas de diseño: elegí la más simple que produzca evidencia, registrá límites/caps y dejá artifacts verificables. No uses Dynamic Workflows para una pregunta simple, una edición de un solo archivo o una tarea que entra en unas pocas tool calls directas. Los intents legacy siguen como rutas: `deep-research` → `complex-research`, `default` → `fan-out-and-synthesize`.

| Scaffold | Usalo para | Elegilo cuando |
| --- | --- | --- |
| `scout-fanout` | Clasificación barata y después tratamiento por clase. | Una auditoría, PR review o migración debería gastar agentes caros solo en archivos de riesgo medio/alto. Verificá: artifact completo de clasificación, conteo de ítems omitidos, evidencia por follow-up. |
| `fan-out-and-synthesize` | Trabajo independiente con una reducción final. | Podés partir por archivos, temas, módulos o perspectivas y necesitás una síntesis que descarte hallazgos sin soporte. Verificá: cobertura, ramas fallidas, caps, hallazgos citados. |
| `adversarial-verify` | Podar claims, bugs sospechados o planes antes de actuar. | El costo de aceptar un falso positivo es alto. Verificá: cada claim termina `verified` o `dropped` con razón y evidencia. |
| `judge-escalate` | Diseñar varias soluciones y elegir con una rúbrica explícita. | Necesitás best-of-N para arquitectura, prompts o estrategia. Verificá: candidatos, rúbrica, puntajes y razones de descarte guardados. |
| `tournament` | Comparaciones por pares y ranking por bracket. | Diseños, prompts o planes tienen que competir mano a mano y el ranking relativo vale más que el puntaje absoluto. Verificá: bracket/matriz, criterios y razón del ganador. |
| `loop-until-dry` | Descubrimiento o reparación de tamaño desconocido. | Tenés que iterar hasta rondas silenciosas, `maxRounds`, presupuesto o timeout. Verificá: log por ronda, criterio de corte y hallazgos deduplicados. |
| `composition-driver` | Descubrimiento local compuesto con una librería de verificación estable. | No hace falta decisión humana entre descubrir y verificar. Verificá: contrato JSON serializable entre padre e hijo, artifacts de ambos. |
| `verify-claims-lib` | Sub-workflow compartido para fact-checking / poda de claims. | Varios workflows necesitan la misma verificación sin copiar prompts. Verificá: input `{ claims, skeptics? }`, output estable y manejo explícito de fallas. |
| `workflow-factory` | Meta-workflow que diseña un workflow específico para la tarea. | La orquestación es lo bastante compleja como para revisar prompts/contratos antes de gastar muchos subagentes. Verificá: draft bajo `.pi/workflows/drafts/`, review y artifacts de decisión. |
| `repo-bug-hunt` | Buscar bugs probables en muchos archivos. | Querés una auditoría amplia reusable, no una revisión manual one-off. Verificá: cobertura de archivos, hallazgos priorizados, citas file/line. |
| `large-migration` | Planificar o ejecutar migraciones en muchos archivos. | Tenés que descubrir blockers, riesgos y caps antes de editar. Verificá: inventario de candidatos, clasificación de riesgo y checklist de migración. |
| `complex-research` | Investigación amplia con fuentes, comparaciones o análisis de migración. | Necesitás perspectivas independientes y citas, no una respuesta rápida. Verificá: fuentes por claim, cobertura de ángulos y límites de investigación. |
| `adversarial-plan-review` | Un panel escéptico antes de implementar una decisión riesgosa. | Un plan necesita crítica desde varias perspectivas. Verificá: riesgos aceptados, cambios recomendados y gaps de verificación. |
| `bug-verify` | Confirmar hallazgos de sweeps antes de reportar o cambiar código. | Tenés bugs/claims sospechados y querés separar evidencia real de alucinación. Verificá: cada hallazgo tiene repro, evidencia concreta o razón de descarte. |

### Plantillas apoyadas en research

Mapeo de papers/frameworks comunes de agentes al diseño de workflows en Pi:

- **ReAct** -> scoutear/observar con tools antes del fan-out; mantener el razonamiento atado a la evidencia.
- **Self-consistency** -> muestrear ramas independientes y luego elegir por consistencia/evidencia, en vez de confiar en un solo camino.
- **Reflexion / Self-Refine** -> loops de generate -> critique -> refine, siempre acotados por rondas, quiet stops, `maxAgents` y timeout.
- **Tree of Thoughts** -> ramificar alternativas, evaluar/podar con un juez y luego comprometerse con un camino.
- **Multiagent debate** -> reviewers adversariales más síntesis-como-juez; los claims sin soporte se descartan.
- **AutoGen / CAMEL / MetaGPT** -> roles explícitos, artifacts estables y contratos de handoff claros.
- **SWE-agent / DSPy** -> importan la interfaz y los contratos: tools estrechos, schemas/formatos fijos y chequeos reproducibles.

Usalos como patterns, no como ceremonia: cada rama necesita una razón, un contrato y una condición de parada.

## Relacionado

- Para `/effort ultracode`, instalá también `./extensions/pandi-effort`.
- Para el bundle completo de extensiones y skills, instalá la raíz del repositorio.
