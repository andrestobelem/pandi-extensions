# judge-escalate

> Generá candidatos desde ángulos distintos, juzgalos con un veredicto tipado y escalá solo cuando la confianza siga baja.

## En 30 segundos

`judge-escalate` es un patrón de `best-of-N` con escalado adaptativo. Primero genera una ronda de candidatos por ángulo, luego un juez elige el mejor con `winner`, `confidence` y `why`; si `confidence` no es `high`, repite con una ronda más rigurosa y vuelve a juzgar sobre todo lo acumulado. Usalo cuando casi siempre hay una respuesta clara, pero vale la pena invertir más cómputo en los casos difíciles.

## Cómo lanzarlo

```text
/workflow new mi-run --pattern=judge-escalate
/workflow run mi-run {"question":"Best rollback strategy for the gate?","angles":["risk-first","simplicity-first","user-first"],"maxEscalations":2}
```

`question` es el único campo obligatorio. `angles` y `maxEscalations` tienen defaults razonables; ver [Input y output](#input-y-output).

## Diagrama

```mermaid
flowchart TD
    A["Input: question (req), angles (default 3, cap 8), maxEscalations (default 2, clamp 0..10)"] --> B{"¿falta question?"}
    B -->|"sí"| B1["throw Error"]
    B -->|"no"| C["Phase: Generate
escalation = 0"]

    subgraph LOOP["while true"]
        subgraph GEN["parallel: un agent por ángulo (settle)"]
            G1["agent cand sonnet·medium
ángulo 1 -> approach"]
            G2["agent cand sonnet·medium
ángulo 2 -> approach"]
            G3["agent cand sonnet·medium
ángulo N -> approach"]
        end
        C --> GEN
        GEN --> D["indexar por posición ORIGINAL del ángulo
(nunca filter-then-index)
candidates.push({angle, text})"]
        D --> E["Phase: Judge
agent judge opus·high, schema VERDICT
sobre TODOS los candidatos acumulados"]
        E --> F{"confidence == 'high'
OR escalation >= maxEscalations?"}
        F -->|"sí"| STOP["break loop"]
        F -->|"no"| INC["escalation += 1
(próxima ronda: prompt 'be more rigorous')"]
        INC --> GEN
    end

    STOP --> H{"verdict.winner en rango?"}
    H -->|"no"| H1["log fuera de rango, fallback a candidate 1"]
    H -->|"sí"| I["winner = candidates[winner-1]"]
    H1 --> I
    I --> J["Phase: Synthesize
agent opus·high
build on winner + graft runners-up + flag riesgos"]
    J --> K["return synthesis (string)"]
```

## Qué hace

`judge-escalate` implementa un `generate-and-filter` adaptativo: en cada iteración lanza un `agent` por cada ángulo declarado (en `parallel`), acumula esos candidatos junto con los de rondas anteriores y pide a un juez (`agent` con `schema` tipado) que elija el mejor y declare su confianza (`high`/`medium`/`low`). Si el juez confía, el loop se detiene ahí; si no, genera otra tanda completa de candidatos —con un prompt más exigente que pide anticipar las objeciones de un crítico escéptico— y vuelve a juzgar sobre el conjunto acumulado completo, no solo sobre la tanda nueva.

La parte dinámica del patrón es ese loop condicionado por el veredicto: el número de rondas no está fijado de antemano, sino que depende de si la confianza llega a `high`, con tope en `maxEscalations` para no gastar sin límite.

Al terminar, un agente de síntesis final construye la respuesta definitiva a partir del candidato ganador, injertando las mejores ideas de los candidatos que no ganaron y marcando riesgos residuales. No descarta el trabajo de los perdedores: lo aprovecha.

Todo texto no confiable (la pregunta del usuario, los candidatos) viaja envuelto en un `fence()` con delimitador derivado de un hash del contenido, para blindar contra inyección de instrucciones dentro de esos textos.

## Cuándo usarlo

- Decisiones donde casi siempre hay un ganador claro entre varias opciones.
- Gasto adaptativo: preferís pagar más cómputo solo en los casos difíciles.
- Selección de la mejor alternativa (`best-of-N`) cuando ya tenés ángulos o criterios distintos para generar candidatos.
- **No usarlo** cuando la comparación es par a par en vez de absoluta: ahí conviene `tournament`, que usa juicio pairwise en vez de un veredicto único sobre todo el conjunto.
- **No usarlo** cuando querés medir consenso entre muestras independientes de un mismo enfoque: ahí conviene `self-consistency`, votación en vez de escalado por confianza.

## Cómo funciona

**Validación de entrada.** `question` (o sus alias `q`/`text`) es obligatorio; si falta, lanza una excepción (`throw`, no aborta con un error suave). `angles` debe ser un array no vacío; se recorta a `MAX_ANGLES = 8` con log si excede. `maxEscalations` se normaliza a entero y se clampa a `[0, MAX_ESCALATIONS = 10]`, con log si el valor pedido difiere del normalizado.

**Fase Generate.** Por cada ángulo, un `agent` (rol `cand`, modelo `sonnet`, effort `medium`) recibe la pregunta envuelta en `fence("topic", question)` y produce una propuesta bajo ese ángulo. Todos los ángulos de la ronda se lanzan en `parallel`. A partir de la segunda ronda (`escalation > 0`), el prompt agrega la frase `Be more rigorous than a basic answer; pre-empt the weaknesses a skeptical critic would raise.`, subiendo el listón. El resultado se indexa por la posición ORIGINAL del ángulo (nunca filtrando y reindexando después); los `null` de fallos bajo `settle` se descartan con log explícito y no se agregan a `candidates`.

**Fase Judge.** Un único `agent` (rol `judge`, modelo `opus`, effort `high`, con `schema: VERDICT`) recibe la pregunta y todos los candidatos acumulados hasta el momento, cada uno truncado a 8000 caracteres vía `compact()` y envuelto en su propio fence. El veredicto tipado exige `winner` (índice 1-based), `confidence` (`high`/`medium`/`low`) y `why`. El loop se corta (`break`) si `confidence === "high"` o si `escalation >= maxEscalations`; si no, incrementa `escalation` y vuelve a Generate.

**Fase Synthesize.** Tras el loop, se valida que `verdict.winner` caiga dentro del rango de `candidates`; si no, se loguea y se usa el candidato 1 como fallback. Un `agent` final (modelo `opus`, effort `high`) recibe la pregunta, el texto del ganador y el conjunto completo de candidatos (truncado a 40000 caracteres), y escribe la respuesta final construyendo sobre el ganador, injertando ideas de los runners-up y señalando riesgos residuales. Este agente no usa `schema`: retorna texto libre, que es lo que el scaffold devuelve como resultado final.

**Manejo de fallos parciales.** Cada fan-out de Generate corre bajo `parallel` con `settle` implícito; un candidato caído se loguea por índice y ángulo, y no bloquea el resto de la ronda ni el veredicto.

**Caching.** No se observa ningún mecanismo explícito de caché: cada `agent` se invoca fresco en cada ronda, y el juez reevalúa el conjunto completo acumulado —no solo lo nuevo— en cada escalada.

## Input y output

| Campo | Tipo | Requerido | Default / clamp |
|---|---|---|---|
| `question` (alias `q`, `text`) | string | **sí** | — (si falta, `throw Error`) |
| `angles` | string[] | no | default `["risk-first","simplicity-first","user-first"]`, cap 8 (`MAX_ANGLES`) |
| `maxEscalations` | number | no | default 2, clamp `[0, 10]` (`MAX_ESCALATIONS`) |
| `model` / `effort` | string | no | override global para todo nodo |
| `models[role]` / `efforts[role]` | object | no | override por rol (`cand`, `judge`, `synthesis`); precedencia: por-rol > global > default del call-site |
| `tools` / `skills` / `excludeTools` (y variantes `*ByRole`) | array | no | se pasan al `agent` si son arrays |

**Output:** el retorno del scaffold es directamente el string producido por el agente de síntesis final (no un objeto con campos separados).

No se observa ninguna llamada a `writeArtifact`: toda la observabilidad pasa por `log(...)` — normalización de `angles`/`maxEscalations`, resultado de cada escalada (`winner`, `confidence`), candidatos descartados por fallo y el conteo final de candidatos junto al veredicto.

## Fases

1. **Generate** — un `agent` por ángulo (modelo `sonnet`, effort `medium`) en `parallel` propone un enfoque distinto a la pregunta; desde la segunda ronda pide mayor rigor.
2. **Judge** — un `agent` (modelo `opus`, effort `high`, `schema` tipado) elige el mejor candidato entre todos los acumulados y declara su confianza; confianza alta o presupuesto agotado corta el loop, si no se vuelve a Generate.
3. **Synthesize** — un `agent` final (modelo `opus`, effort `high`) escribe la respuesta definitiva construyendo sobre el candidato ganador, injertando ideas de los runners-up y señalando riesgos residuales.
