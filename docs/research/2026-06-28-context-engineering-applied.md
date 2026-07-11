---
type: "Research Review"
title: "Context Engineering, Aplicado: mapeo de la investigación a nuestras extensiones"
description: "Mapeo de la investigación de context engineering a las extensiones de Pandi."
tags: [context-engineering, extensions, audit, pandi]
timestamp: 2026-06-28T00:00:00Z
---

# Context Engineering, Aplicado: mapeo de la investigación a nuestras extensiones

> **Estado: ANÁLISIS.** Complemento de `2026-06-28-context-engineering-focus.md`. Relee esa investigación como una
> auditoría concreta de las extensiones de este paquete: qué ya implementa cada palanca, dónde están las brechas y qué
> arreglos realmente valen la pena. Este documento no cambia código; es el entregable de “pensar a fondo” que precede a
> cualquier plan.

---

## 1. Reencuadre central

La investigación presenta el contexto como un **presupuesto finito de atención**, no como un recipiente para llenar.
Cuatro modos de falla concretos ordenan todo lo demás:

- **Lost in the middle** — los modelos atienden más al inicio y al final del contexto, y descuidan el medio (curva en
  U).
- **Context rot** — la confiabilidad cae a medida que crece la entrada bruta, incluso en tareas triviales.
- **Distraction** — una sola frase fuera de tema, pero parecida, desvía la atención.
- **Instruction-following decay** — la obediencia a las reglas disminuye con la longitud, separable de la recuperación.

La conclusión más llamativa para _este_ paquete: **la mayoría de las mitigaciones del paper ya existen aquí como
mecanismos de runtime.** La arquitectura es, en la práctica, “context engineering operacionalizado”. El valor está en
(a) reconocerlo explícitamente y (b) cerrar seis o siete brechas puntuales.

---

## 2. Qué ya está implementado (palanca de investigación → extensión)

| Palanca de investigación                                                 | Dónde vive                                | Evidencia en el código                                                                                                                                                  |
| ------------------------------------------------------------------------ | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Memoria externa / offloading (§3b, MemGPT)                               | `pandi-local-memory`                      | Inyecta `MEMORY.md` con tope (200 líneas/25 KB); los archivos de tema se **listan pero se leen bajo demanda** = just-in-time de manual                                  |
| Recuperación just-in-time (§3c)                                          | `pandi-dynamic-workflows` + memory        | Scout barato (`git ls-files`/grep/glob), referencias + carga on-demand, `writeArtifact` saca volumen fuera del chat                                                     |
| Presupuesto pequeño de herramientas (§3d, LongFuncEval 7–85%)            | personas de workflow                      | `READ_ONLY_AGENT_TOOLS = [read, grep, find, ls]` + `--no-extensions` por defecto (salvo `includeExtensions:true`)                                                       |
| Aislar-para-leer / un solo hilo para escribir (§3d, Cognition↔Anthropic) | personas read-only + synthesis-as-judge   | `explore`/`reviewer`/`researcher` son read-only; el orquestador comprime hallazgos                                                                                      |
| Recitación / reanclar el objetivo (§3e, Manus)                           | `pandi-goal` + `pandi-loop`               | Se reinyecta un molde estable en cada iteración; `successCriteria` se registra UNA sola vez como definición de listo; el progreso queda **acotado** (anti self-mimicry) |
| Trayectoria + evaluación adversarial (§4, τ-bench)                       | verificador independiente de `pandi-goal` | Un verificador escéptico read-only juzga contra criterios con evidencia, no intuición                                                                                   |
| Topología antes que moda (§3d)                                           | router de Ultracode + Contract Gate       | Un gate trivial evita sobre-orquestación; Contract Gate sintetiza un contrato antes de escalar                                                                          |
| Compaction cerca del umbral (§3b)                                        | `pandi-auto-compact`                      | Disparo por borde relativo al 30%; se rearma desde el % post-compaction para evitar loops; la barra del footer es un gauge de presupuesto                               |
| Separación de autoridad (§3a)                                            | `pandi-local-memory`                      | Las directivas durables van al canal de sistema (contenido confiable, escrito por `remember`/human)                                                                     |

---

## 3. Brechas de mayor valor (priorizadas)

### 3.1 Compaction recuperable — la brecha más fuerte (§3b)

`pandi-auto-compact` llama a `ctx.compact()` (un resumen del harness) **sin acoplarlo a memory/artifacts**. El paper es
explícito: la summarization recursiva puede perder un dato que luego necesitás; _conservá el material crudo afuera para
que la compactación sea recuperable, no destructiva_. El umbral del 30% es agresivo y bueno para el presupuesto de
atención, pero amplifica el riesgo de errores en cascada. Solución: guardar el estado clave en `.pi/memory` o en un
artifact del run antes de compactar (o pedirle al agente que lo haga).

### 3.2 Limpieza de tool results como palanca más barata que la compactación completa (§3b)

El paper distingue _tool-result clearing_ (descartar payloads voluminosos ya consumidos, conservar la decisión) de la
_compaction_ completa. Hoy solo tenemos compactación al 30%. Una palanca intermedia que limpie salidas de herramientas
ya digeridas aliviaría presión sin el riesgo de cascada de la summarization. Complementa a 3.1.

### 3.3 Prompts de síntesis sensibles a la posición (§2, lost-in-the-middle)

Cuando la fase de síntesis de un workflow recibe N salidas de ramas, poné **tarea + criterios al inicio Y al final** del
prompt de síntesis, y reordená la evidencia más fuerte hacia los bordes. Vale la pena codificarlo en prompts de síntesis
y scaffolds de patrones: es barato y contrarresta directamente la U-curve.

### 3.4 Prefijo estable de KV-cache en workflows (§3e, Manus + prompt caching)

Mantené prefijos de prompt de subagentes estables, empujá el contenido volátil o por ítem al final, y evitá
`Date.now()`/`Math.random()` al principio. Esto importa por dos motivos: protege el cache del proveedor y determina si
una llamada queda cacheada para `resume` (el journal del content-address cache). Conviene codificar la guía de “stable
prefix” en la construcción de prompts.

### 3.5 Guardia de autoridad sobre memory (§3a, anti-injection)

`remember` escribe en el canal de sistema (hoy confiable). Agregá un **non-goal** explícito: nunca ingerir contenido no
confiable de herramientas o retrieval hacia `.pi/memory`. Defensa en depth barata; los delimitadores no son una barrera
de seguridad.

### 3.6 Observabilidad del foco (§4: token growth, tool-error rate, trajectory)

La barra de auto-compactación (budget gauge) y el log de progreso del goal ya existen. **La brecha:** extender la
observabilidad a los **workflow runs** — capturar por paso el crecimiento de tokens, la tasa de errores de herramientas
y los retries como artifacts, en espíritu de los spans de OpenTelemetry GenAI. Esta es la parte de “medir el foco en
vivo”.

### 3.7 Evals estilo NoLiMa (§4: no depender de NIAH literal)

Las suites de integración verifican comportamiento; el verificador de goal ya es basado en evidencia (no lexical).
Oportunidad menor: al agregar context evals, gatear sobre **needles no lexicales + distractores**, no sobre matches
literales.

---

## 4. Recomendación

Los dos ítems de mayor ROI y menor riesgo son **3.1 (compaction recuperable)** y **3.3 (síntesis sensible a la
posición)**: atacan los dos modos de falla centrales del paper (cascade de compactación + lost-in-the-middle) con
cambios quirúrgicos sobre extensiones ya bien entendidas. Orden sugerido: planear 3.1 primero (cruza
`pandi-auto-compact` + memory/ artifacts y merece un pass de diseño), y luego hacer 3.3 como follow-up acotado.

---

## 5. Estado de implementación

> **Estado: IMPLEMENTADO.** Las siete brechas priorizadas se publicaron como commits atómicos separados, cada uno
> verificado contra el gate completo de `npm test` (typecheck + eslint + prettier + markdownlint + integration). Cada
> cambio es quirúrgico y aditivo — sin breaking changes en contratos públicos — en línea con el ethos de “la complejidad
> debe ganarse su lugar”.

| Gap | Qué se envió                                                                                                                                                                                                           | Commit    |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| 3.1 | Compaction recuperable: snapshot del transcript crudo antes de `ctx.compact()` (hooks `session_before_compact`/`session_compact`), pruning + subcomandos `snapshot`/`snapshots`, env `PI_AUTO_COMPACT_SNAPSHOT[_KEEP]` | `9caf486` |
| 3.2 | Limpieza opt-in de tool results (`clearOldToolResults`) en el hook `context` — más barata que compactar, efímera, fail-safe, desactivada por defecto                                                                   | `ee01db5` |
| 3.3 | Síntesis sensible a la posición: reexpresar task + criteria en AMBOS extremos de los scaffolds de síntesis; guía del router con ambos extremos                                                                         | `56d1140` |
| 3.4 | Guía de prefijo estable de KV-cache en la construcción de prompts de subagentes (solo guía/docs)                                                                                                                       | `51c318a` |
| 3.5 | Guardia de autoridad sobre `remember`: non-goal anti-injection (nunca ingerir contenido no confiable; los delimitadores no son barrera de seguridad)                                                                   | `0d2d18e` |
| 3.6 | Artifacts de métricas por run (`metrics.json`/`metrics.md`): token growth, tool-error rate, retries — consolidados desde stdout JSON-mode de cada subagente                                                            | `8fe6c8a` |
| 3.7 | Primitiva de eval NoLiMa-style (`eval-needle.mjs`): needle no lexical + distractores lure lexicales, nunca gatear sobre la string literal del needle                                                                   | `900650b` |

Cambio de apoyo: un helper de exportación de chat (`scripts/export-chat.mjs`, commit `2f56776`) escribe el HTML de la
sesión en `.pi/chats/`, y `.gitignore`/`.prettierignore` ahora ignoran exports sueltos `pi-session-*.html` en la raíz
para que el gate de formato siga verde.
