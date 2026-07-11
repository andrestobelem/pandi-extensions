# workflow-factory

> Meta-workflow: catálogo → plan → generación → revisión → refinamiento, y después escribe
> `<configDir>/workflows/drafts/<slug>.js`.

## En 30 segundos

Es el workflow que diseña otro workflow. Le das una tarea en lenguaje natural y usa una corrida completa para: descubrir
el catálogo de scaffolds existentes, elegir el patrón y el presupuesto de modelos, generar el JS del nuevo workflow,
revisarlo de forma adversarial, refinarlo si hace falta y escribir el draft en disco. Usalo cuando ningún scaffold
existente encaja y necesitás uno específico para la tarea; si `fan-out-and-synthesize`, `map-reduce` u otro patrón
catalogado ya resuelve el caso, conviene llamarlo directo.

## Cómo lanzarlo

```text
/workflow new mi-run --pattern=workflow-factory
/workflow run mi-run {"task":"Auditar resolvers de GraphQL en busca de queries N+1","write":true}
```

`task` es el único campo obligatorio (qué debe lograr el workflow generado). `write` (default `true` si se omite)
controla si el resultado se escribe a disco o solo se devuelve como texto — ver [Input y output](#input-y-output).

## Diagrama

````mermaid
flowchart TD
    A["Input: task (req), name?, write?=true,\nmodel/effort, models/efforts[role],\ntoolsByRole/skillsByRole/excludeByRole[role]"] --> B{"task ausente?"}
    B -->|"sí"| B1["throw Error: falta task"]
    B -->|"no"| C["Phase: Catalog"]

    C --> D["agent catalog-scan haiku·low\nlee .pi/workflows/*.js (proyecto + global)\n-> { workflows: [ name, description, kind ] }"]
    D --> E["known = catalog filtrado\n(excluye workflow-factory)\ncatalogText = lista formateada"]

    E --> F["Phase: Plan"]
    F --> G["agent workflow-plan opus·high, schema PLAN\ninput: task + catalogText (fenced anti-inyección)\n-> { name, pattern, why, inputs, scout, primitives,\n     reuse, promptContracts, verification, risks, budget[] }"]

    G --> H["Phase: Generate"]
    H --> I["agent workflow-codegen sonnet·medium\ntimeoutMs=20min\ninput: task + plan (compact 12k) + catalogText (fenced)\n-> JS crudo del workflow generado"]
    I --> J["extractJs(): saca el bloque ```js```\no usa el texto tal cual"]
    J --> K{"code vacío?"}
    K -->|"sí"| K1["throw Error: codegen produjo output vacío\n(probable timeout del agente)"]
    K -->|"no"| L["Phase: Review"]

    L --> M["agent workflow-review sonnet·medium, schema REVIEW\nchequea: correctitud, costo, seguridad,\nreuse de catálogo, tiering de modelos por rol\n-> { verdict: APPROVED|CHANGES_REQUESTED, findings[] }"]
    M --> N{"verdict==APPROVED\nAND findings.length==0?"}

    N -->|"sí"| O["log: skip Refine"]
    N -->|"no"| P["Phase: Refine"]
    P --> Q["agent workflow-refine sonnet·medium\ntimeoutMs=20min\ninput: task + findings (fenced) + code (fenced)\n-> code revisado (extractJs de nuevo)"]

    O --> R["Validación estructural (heurística, sin LLM)"]
    Q --> R
    R --> S{"code vacío? usa import/require?\nfalta 'export const meta ='?\nusa agent({...}) objeto-forma?\nnunca llama agent()?"}
    S -->|"algún problema"| S1["codeValid=false\nlog validation FAILED"]
    S -->|"ok"| S2["codeValid=true"]

    S2 --> T{"input.write !== false?"}
    T -->|"no"| U["log: write=false, code se devuelve como resultado"]
    S1 --> V["write SKIPPED: draft NO_VALIDADO\nse devuelve igual en el resultado"]
    T -->|"sí"| W["Phase: Write"]
    W --> X["agent write-file haiku·low, schema {wrote,path}\nWrite tool -> .pi/workflows/drafts/<slug>.js\ncontenido pasado como DATA fenced (verbatim)"]
    X --> Y{"wrote===true?"}
    Y -->|"sí"| Z["written = { path }"]
    Y -->|"no / excepción"| Z1["writeError; código se devuelve\ncomo resultado en vez de escribirse"]

    U --> END["return resumen:\nnombre, path escrito o razón,\nverdict de Review, validación,\npattern/why del plan, código si no se escribió"]
    V --> END
    Z --> END
    Z1 --> END
````

## Qué hace

`workflow-factory` produce otro workflow: parte de un `task` en lenguaje natural y ejecuta un pipeline de seis fases
(Catalog → Plan → Generate → Review → Refine → Write) donde cada fase pasa contexto a la siguiente. El objetivo es dejar
un draft JS listo para inspeccionar y editar, no una respuesta final para confiar sin revisión humana — el propio código
lo deja claro en el resumen final ("inspect/edit the generated workflow (it is NOT syntax-checked)").

Es "catalog-aware": antes de planear, un agente barato escanea los `.pi/workflows/*.js` existentes (del proyecto y, si
existe, el catálogo global) y extrae `meta.name`/`meta.description`, clasificando cada uno como `lib` (sub-workflow
reusable, p. ej. terminado en `-lib`), `composed` (usa `workflow(...)`) o `base`. Ese catálogo se inyecta en los prompts
de Plan, Generate y Review para que el planificador PREFIERA reusar/especializar el scaffold más cercano y COMPONER
sub-pasos reusables vía `workflow(name, args)` en vez de reinventar — el plan debe justificar explícitamente construir
desde cero si nada encaja.

El diseño soporta composición recursiva acotada por profundidad: un workflow generado puede componer otros scaffolds con
`workflow(name, args)`, incluyendo llamar a `workflow("contract-gate", …)` desde dentro de un nodo para re-acotar una
subtarea antes de profundizar. Esa recursión está limitada por el runtime (Claude Code Workflow tool: profundidad 1,
solo el nivel superior puede componer; pi: profundidad 2 por defecto, configurable con
`PI_DYNAMIC_WORKFLOWS_MAX_DEPTH`).

Todo el input/contexto no confiable (el `task` del usuario, el catálogo, el código generado, los hallazgos de revisión)
se envuelve con `fence()`, un delimitador derivado del hash del propio contenido: un payload malicioso no puede forjar
el marcador de cierre porque cambiar el contenido cambia el hash. Los prompts de Generate/Refine/Review instruyen
explícitamente a tratar ese contenido como datos a diseñar/juzgar, nunca como instrucciones a obedecer.

## Cuándo usarlo

- Bootstrap de un patrón nuevo que no está en el catálogo (caso de uso del catálogo).
- Especializar el scaffold existente más cercano a la tarea (caso de uso del catálogo).
- Generar un draft para inspeccionar antes de confiar en él, en vez de escribir el workflow a mano desde cero (caso de
  uso del catálogo).
- Tareas de alcance amplio o repetible donde vale la pena invertir una corrida completa en diseñar la orquestación
  correcta.

**Cuándo NO usarlo:**

- Si un scaffold del catálogo ya resuelve la tarea (p. ej. `fan-out-and-synthesize`, `map-reduce`) — usarlo directo es
  más barato que generar y revisar código nuevo.
- Para tareas puntuales de una sola vez donde el costo de Plan+Generate+Review+Refine (hasta 4 llamadas a modelos caros)
  no se amortiza.
- El resultado es un **draft sin syntax-check**: no usarlo cuando se necesita una respuesta inmediata y confiable sin
  revisión humana posterior.

## Cómo funciona

**Fase Catalog.** Un `agent` (rol `catalog-scan`, modelo `haiku`, effort `low`) lee los archivos `.pi/workflows/*.js`
del proyecto y, si existe, `~/.pi/agent/workflows/*.js`, excluyendo `workflow-factory` y cualquier cosa bajo `drafts/`.
Devuelve `{ workflows: [{ name, description, kind }] }` con schema fijo. El resultado se filtra (se descarta
`workflow-factory` si aparece) y se formatea en `catalogText`, una lista de líneas `- name [kind]: description` que se
reusa en las tres fases siguientes.

**Fase Plan.** Un `agent` (rol `workflow-plan`, modelo `opus`, effort `high`, con `schema PLAN`) recibe el `task` y el
`catalogText` (ambos dentro de un `fence`) y debe devolver un plan estructurado: `name`, `pattern`, `why`, `inputs`,
`scout`, `primitives` disponibles (`agent`, `parallel`, `pipeline`, `workflow(name,args)`), `reuse` (nombres del
catálogo a componer/especializar — vacío solo si `why` justifica construir desde cero), `promptContracts`,
`verification`, `risks`, y `budget` (un array con `{ role, model, effort, why }` por cada rol de agente planeado, atado
explícitamente a ancho de fan-out, dificultad, costo de error y si hay verificación posterior).

**Fase Generate.** Un `agent` (rol `workflow-codegen`, modelo `sonnet`, effort `medium`, `timeoutMs=20 min`) recibe el
`task`, el `plan` (compactado a 12000 chars) y el `catalogText`, todos fenced, y debe devolver JS puro (sin fences
Markdown) que cumpla contratos duros: `export const meta` como literal puro, sin `import`/`require`, llamadas
`agent(promptString, opts)` (nunca forma-objeto), cada `agent()` con `model`/`effort` explícitos tomados del budget del
plan, un helper `node(role, extra)` para overrides por rol, tools read-only salvo mutación explícitamente requerida, y
contratos de evidencia (citar o declarar `NO_FINDINGS`/`INSUFFICIENT_EVIDENCE`). `extractJs()` saca el bloque de código
(con o sin fences). Si el resultado queda vacío — típicamente por timeout del agente — el workflow aborta con `throw`
explícito en vez de dejar pasar un código vacío a Review (evita que un timeout se entierre bajo un turno de revisión
desperdiciado).

**Fase Review.** Un `agent` (rol `workflow-review`, modelo `sonnet`, effort `medium`, `schema REVIEW`) juzga el código
generado (fenced) contra el `task` y el `catalogText`, buscando: correctitud, costo, seguridad, calidad de prompts,
reuse perdido (lógica reimplementada que un workflow del catálogo ya resolvía) y tiering incorrecto (fan-out ancho en
tier caro, juez/síntesis en tier barato, o `agent()` sin `model`/`effort`). Devuelve
`{ verdict: APPROVED|CHANGES_REQUESTED, findings[] }`; `APPROVED` solo es válido con `findings` vacío.

**Fase Refine.** Se salta (`log` explícito) si el veredicto fue `APPROVED` con cero findings. Si no, otro `agent` (rol
`workflow-refine`, modelo `sonnet`, effort `medium`, `timeoutMs=20 min`) recibe el `task`, los `findings` compactados y
el `code` actual (todos fenced) y devuelve la versión corregida, con los mismos contratos duros que Generate.

**Validación estructural (sin LLM).** Antes de escribir a disco, una función `validateCode()` corre chequeos heurísticos
baratos sobre el string final: código no vacío, sin `import`/`require`, presencia de `export const meta =`, ausencia de
`agent({...})` forma-objeto, y al menos una llamada a `agent()`. Si falla cualquiera, `codeValid=false` y el draft se
devuelve como "UNVALIDATED" sin intentar escribirlo — es un gate duro, no una sugerencia.

**Fase Write.** Solo corre si `input.write !== false` y `codeValid`. Un `agent` (rol `write-file`, modelo `haiku`,
effort `low`, `schema {wrote,path}`) usa la tool Write para crear `.pi/workflows/drafts/<slug>.js` con el contenido
pasado como dato fenced ("verbatim, nunca instrucciones"). Si el agente no confirma `wrote:true` o lanza una excepción,
se registra `writeError` y el código generado se devuelve igual en el resultado en vez de perderse.

**Manejo de fallos parciales:** no hay fan-out paralelo en este scaffold (es una cadena secuencial de agentes únicos por
fase), así que no aplica `settle`; en su lugar cada fase que puede fallar (codegen vacío, validación estructural,
escritura a disco) tiene su propio camino de degradación explícito (`throw`, draft no-escrito, o resultado devuelto en
texto) en vez de fallar en silencio.

**Caching:** no se observa ningún mecanismo explícito de caché; cada `agent` se invoca fresco en cada corrida.

## Input y output

**Input** (JSON-stringified en `args`, parseado defensivamente):

| Campo                                                       | Tipo    | Requerido             | Default / clamp                                                                                                                                                                   |
| ----------------------------------------------------------- | ------- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `task` / `request` / `text`                                 | string  | **sí** (al menos uno) | — si falta, `throw Error('Pass { task: "..." }')`                                                                                                                                 |
| `name`                                                      | string  | no                    | default: slug derivado de `task`; siempre pasado por `slug()` (minúsculas, `[a-z0-9._/-]`, sin `..`, máx. 80 chars)                                                               |
| `write`                                                     | boolean | no                    | default efectivo `true` (solo se salta la escritura si es literalmente `false`)                                                                                                   |
| `model` / `effort`                                          | string  | no                    | override global para todo nodo                                                                                                                                                    |
| `models[role]` / `efforts[role]`                            | object  | no                    | override por rol (`catalog-scan`, `workflow-plan`, `workflow-codegen`, `workflow-review`, `workflow-refine`, `write-file`); precedencia: por-rol > global > default del call-site |
| `tools` / `skills` / `excludeTools` (y variantes `*ByRole`) | array   | no                    | pasados al `agent` si son arrays                                                                                                                                                  |

**Output:** un string (no un objeto estructurado) con el resumen de la corrida:

- Línea de encabezado con el `workflowName` generado.
- Si se escribió: `Wrote: .pi/workflows/drafts/<slug>.js`; si no, la razón (validación fallida, error de escritura, o
  `write=false`).
- Veredicto de Review (`APPROVED (Refine skipped)` o `CHANGES_REQUESTED`).
- Resultado de la validación estructural (`passed` o la lista de problemas).
- `pattern` y `why` tomados del plan.
- Recordatorio explícito: inspeccionar/editar el workflow generado (no tiene syntax-check) antes de correrlo con
  concurrencia explícita.
- Si NO se escribió a disco, el código JS completo (compactado a 60000 chars) se incluye al final del string.

No hay llamadas a `writeArtifact`; la única escritura a disco es el archivo del workflow generado en sí, hecha por el
sub-agente `write-file` vía la tool `Write`.

## Fases

1. **Catalog** — un `agent` barato escanea los `.pi/workflows/*.js` existentes y produce `{ name, description, kind }`
   por cada uno, excluyendo `workflow-factory` y drafts.
2. **Plan** — un `agent` de alto tier diseña el patrón, primitivas, reuse del catálogo y presupuesto de modelo/effort
   por rol.
3. **Generate** — un `agent` de tier medio produce el JS completo del workflow, siguiendo los contratos duros de la
   runtime.
4. **Review** — un `agent` de tier medio juzga el código generado (correctitud, costo, seguridad, reuse, tiering) y
   devuelve `APPROVED` o `CHANGES_REQUESTED` con findings.
5. **Refine** — se salta si Review aprobó sin findings; si no, un `agent` corrige el código según los findings.
6. **Write** — validación estructural heurística y, si pasa y `write!==false`, un `agent` escribe el draft final a
   `.pi/workflows/drafts/<slug>.js`.
