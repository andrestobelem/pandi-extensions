# complex-research

> Ángulos de investigación independientes (cada uno con búsqueda web), sintetizados por un agente juez con citas y vacíos de cobertura.

## En 30 segundos

Es un "pedile a N investigadores que ataquen la misma pregunta desde ángulos distintos, y a un quinto que arbitre": cada agente de research busca en la web de forma independiente (sin ver a los demás) y un agente juez de alto esfuerzo dedupe, prioriza evidencia primaria y reporta qué ángulos fallaron. Elegilo cuando necesitás una respuesta con citas a una pregunta externa (comparación de tecnologías, escaneo de panorama/literatura) — no para tareas de código/repo local, ni cuando necesitás verificación de claims (para eso, encadená `adversarial-verify` después).

## Cómo lanzarlo

```text
/workflow new mi-run --pattern=complex-research
/workflow run mi-run {"question": "WASM vs NAPI FFI para Node en 2026: cual conviene?"}
```

`question` (alias `q`, `text`) es el único campo obligatorio; `angles` es opcional (default: 4 ángulos fijos). Ver [Input y output](#input-y-output) para overrides (`angles`, `model`, `models`, `tools`, etc.).

## Diagrama

```mermaid
flowchart TD
    IN["Input: question, angles?"] --> VAL{"question presente?"}
    VAL -- no --> ERR["throw Error"]
    VAL -- si --> ANG["Resolver angles<br/>(default: 4 angulos fijos)<br/>clamp a 64, log si se recorta"]
    ANG --> FANOUT["parallel: un agent por angulo"]

    subgraph "Fase Research (fan-out, settle)"
        FANOUT --> R1["agent research-1<br/>model haiku, effort low"]
        FANOUT --> R2["agent research-2<br/>model haiku, effort low"]
        FANOUT --> R3["agent research-N...<br/>model haiku, effort low"]
    end

    R1 --> M1{"output null?"}
    R2 --> M2{"output null?"}
    R3 --> M3{"output null?"}
    M1 -- si --> NULL1["null (descartado)"]
    M2 -- si --> NULL2["null (descartado)"]
    M3 -- si --> NULL3["null (descartado)"]
    M1 -- no --> OK1["{name, output}"]
    M2 -- no --> OK2["{name, output}"]
    M3 -- no --> OK3["{name, output}"]

    OK1 --> FILTER["filter(Boolean)<br/>completedResearch"]
    OK2 --> FILTER
    OK3 --> FILTER
    NULL1 --> COUNT["failed = total - completed"]
    NULL2 --> COUNT
    NULL3 --> COUNT

    FILTER --> GATE{"completedResearch.length === 0?"}
    GATE -- si --> FAILRET["return: 'All research branches<br/>failed/empty...' (sin sintesis)"]
    GATE -- no --> SYN

    subgraph "Fase Synthesis"
        SYN["agent research-synthesis<br/>model opus, effort high<br/>synthesis-as-judge"]
    end

    SYN --> OUT["return: Markdown final<br/>(resumen, recomendacion, evidencia,<br/>tradeoffs, riesgos, gaps de cobertura)"]
```

## Qué hace

`complex-research` es el patrón base de scatter-gather aplicado a investigación: lanza N agentes de investigación en paralelo, cada uno cubriendo un "ángulo" distinto (fuentes primarias, opciones de implementación, riesgos, recomendación) con búsqueda web independiente. Ningún agente ve el trabajo de los demás; el fan-out es puramente de exploración divergente.

Cuando todos los ángulos terminan (o fallan), un único agente de síntesis actúa como juez: deduplica hallazgos, prioriza evidencia primaria sobre secundaria, marca incertidumbre explícitamente, y reporta cuántas ramas de investigación fallaron o quedaron vacías. El resultado es un documento Markdown en formato fijo (resumen ejecutivo → recomendación → evidencia → tradeoffs → riesgos → vacíos de cobertura), no un objeto estructurado validado por schema.

El scaffold está diseñado explícitamente como patrón **base** (`basedOn: fan-out-and-synthesize`), no compuesto: la doc del archivo advierte que para respuestas consecuentes conviene encadenarlo con un paso de verificación posterior (p.ej. `adversarial-verify`), ya que este workflow no verifica sus propias afirmaciones, solo las sintetiza con honestidad sobre sus lagunas.

Todo el contenido no confiable (la pregunta/ángulo, y cualquier contenido web/página que los agentes de research obtengan, así como los outputs de research que ve el sintetizador) se envuelve con un delimitador derivado de un hash del contenido (`fence`), para que un payload malicioso no pueda falsificar el marcador de cierre y así intentar inyectar instrucciones a los agentes que leen esos datos.

## Cuándo usarlo

| Situación | ¿Usarlo? |
|---|---|
| Pregunta externa que necesita respuesta con citas (comparación de tecnologías, ej. "WASM vs NAPI FFI para Node en 2026") | Sí |
| Escaneo de literatura o panorama de un tema (landscape scan) | Sí |
| Paso previo a una verificación (pair with a verify step) | Sí, pero no como respuesta final si el tema es de alto riesgo/consecuencia |
| Tarea de código/repo local, sin investigación externa | No — usá un patrón de exploración de repo |
| Necesitás garantías de verificación de claims (este workflow sintetiza, no refuta) | No — combinalo con `adversarial-verify` o similar |
| El output debe ser un objeto estructurado/schema-validado | No — acá el resultado es texto libre en Markdown, sin validación de schema |

## Cómo funciona

**Fase Research (fan-out):**

- Se resuelven los `angles`: si el input trae `angles` (array no vacío), se usan tal cual; si no, se usa el default fijo de 4 ángulos (fuentes primarias/docs oficiales; opciones de implementación y tradeoffs; riesgos/gotchas/migración; mejor recomendación con evidencia).
- Se aplica un clamp a 64 ángulos máximo, con `log` si se recorta.
- `parallel(...)` lanza un `agent(...)` por cada ángulo, cada uno con rol lógico `"research"`, `model: "haiku"`, `effort: "low"` (overridable vía `input.models.research` / `input.efforts.research`, o globalmente vía `input.model` / `input.effort`), y etiqueta `research-{i}-{ángulo truncado a 40 chars}`.
- Cada agente de research recibe instrucciones anti-inyección (tratar el contenido entre marcadores `<untrusted-…>` como datos, nunca como instrucciones), reglas de evidencia (preferir fuentes primarias, citar solo lo observado, separar hechos/interpretación/preguntas abiertas, declarar `INSUFFICIENT_EVIDENCE` si falta evidencia), y un formato de salida fijo (Key findings / Evidence-sources / Tradeoffs / Risks-gotchas / Recommendation for this angle).
- `parallel` opera en modo "settle": cada `.then()` mapea el output del agente a `null` si viene vacío/fallido, o a `{ name, output }` si tuvo éxito — es decir, una rama que falla no aborta el fan-out completo.
- Tras el fan-out se filtran los `null` (`completedResearch`) y se calcula `failed = total - completed`, dejando log de la cobertura.
- **Gate de fallo total:** si `completedResearch.length === 0` (todas las ramas fallaron o vinieron vacías), el workflow corta ahí y retorna un mensaje explícito de fallo sin invocar síntesis — evita sintetizar "de la nada".

**Fase Synthesis:**

- Un solo `agent(...)` con rol lógico `"research-synthesis"`, `model: "opus"`, `effort: "high"` recibe: la pregunta original, contadores de cobertura (ángulos pedidos / completados / fallidos), y los outputs de investigación completados, comprimidos con `compact(..., 90000)` (trunca a 90.000 caracteres con marca `…[truncated]`) y envueltos en el fence anti-inyección bajo la etiqueta `"findings"`.
- Las instrucciones de síntesis fijan el patrón "synthesis-as-judge": deduplicar, preferir evidencia primaria, marcar incertidumbre, y mencionar explícitamente las ramas fallidas/vacías, con formato de salida fijo de 6 secciones.
- No hay reintentos ni loop: es un pipeline lineal fan-out → filtro → gate → síntesis, ejecutado una sola vez.
- No hay `writeArtifact`; el output es simplemente el texto retornado por el agente de síntesis (o el mensaje de fallo total).
- Personalización por rol vía `node(role, extra)`: permite overrides de `model`, `effort`, `tools`, `skills`, `excludeTools` por rol lógico (`research`, `research-synthesis`) o global, con precedencia rol > global > default del scaffold.

## Input y output

**Input** (JSON-stringified en `args`):

| Campo | Tipo | Requerido | Default / comportamiento |
|---|---|---|---|
| `question` (alias `q`, `text`) | string | Sí | Si falta, `throw new Error('Pass { question: "..." } as workflow input.')` |
| `angles` | string[] | No | Default: 4 ángulos fijos (docs/fuentes primarias; opciones e implementación; riesgos/gotchas/migración; mejor recomendación con evidencia). Se recorta (`slice`) a máx. 64, con log si se excede |
| `model` / `effort` | string | No | Defaults globales aplicados a todo nodo salvo override por rol |
| `models.{role}` / `efforts.{role}` | object | No | Override por rol (`research`, `research-synthesis`); precede al global |
| `tools` / `toolsByRole.{role}` | array | No | Herramientas por nodo/rol |
| `skills` / `skillsByRole.{role}` | array | No | Skills por nodo/rol |
| `excludeTools` / `excludeByRole.{role}` | array | No | Exclusión de herramientas por nodo/rol |

**Output:**

- Texto libre en Markdown (no validado por schema) con la síntesis final: resumen ejecutivo, recomendación, evidencia/fuentes, tradeoffs, riesgos/preguntas abiertas, vacíos de cobertura y ramas fallidas.
- Caso de fallo total: string fijo `"All research branches failed/empty; no synthesis produced. Re-run or narrow the question."`
- No escribe `writeArtifact`; todo el resultado viaja como valor de retorno del workflow.

## Fases

1. **Research** — Fan-out paralelo de agentes independientes (uno por ángulo), cada uno con búsqueda web propia, produciendo hallazgos por perspectiva; ramas fallidas se descartan sin abortar el resto.
2. **Synthesis** — Un agente-juez único sintetiza las ramas completadas en una respuesta final citada, marcando incertidumbre y vacíos de cobertura (o, si no hubo ninguna rama exitosa, el workflow corta antes de esta fase y devuelve un mensaje de fallo).
