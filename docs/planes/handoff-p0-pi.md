# Handoff a Pi — Implementar P0 (paridad con Claude Dynamic Workflows)

Brief para que Pi implemente la fase **P0** del plan de paridad. Plan completo y fundamento:
`docs/planes/2026-06-25-paridad-claude-dynamic-workflows.md` (leerlo antes de empezar). Todo ocurre en un
solo archivo salvo docs: **`extensions/dynamic-workflows.ts`**.

## Objetivo y alcance

P0 = las fundaciones que no dependen de ninguna decisión abierta y que multiplican el resto. Son **tres
tareas** sobre el mismo archivo: **B** (robustez del resume), **A** (`parallel()` + `agents({settle})`),
**C1** (guía de decisión). **No** implementar P1/P2 (structured output, pipeline, budget, ctx.workflow,
worktree, determinismo, agentType) en esta fase.

**Reglas duras:**
- No romper el resume/idempotencia ya existente ni la feature ultracode (`/ultracode-mode`,
  `before_agent_start`, `wakeAgentForWorkflowResult`).
- No agregar dependencias. `parallel`/`settle` son **aditivos y opt-in** (no cambiar el comportamiento por
  defecto de `agents()`).
- Trabajar secuencial: las tres tareas tocan el mismo archivo. Verificar sintaxis (esbuild) tras cada una.
- Confirmar los anclajes con `grep`/lectura antes de editar (los números de línea pueden estar corridos).

---

## Tarea B — robustez del resume (correctitud; va primero)

**Por qué:** `appendJournalRecord` y `appendEvent` usan `fs.appendFile` crudo sin serializar. Con `agents()`
concurrente y outputs grandes (hasta `MAX_JOURNALED_STREAM = 200_000`), dos líneas grandes pueden
intercalarse → JSON roto → `loadJournal` las descarta → en resume se **re-ejecutan agentes ya completados**
(pérdida de tokens). Además el truncado divergente rompe la garantía `resume == fresh`.

1. **Serializar escrituras (mutex por archivo).** Agregar una clase `AsyncMutex` (`runExclusive(fn)`) y un
   `Map<string, AsyncMutex>` global keyed por path absoluto. Envolver con el mutex del path:
   - `appendJournalRecord(runDir, record)` (escritura a `journal.jsonl`).
   - `appendEvent(event)` dentro de `runWorkflow` (escritura a `events.jsonl`).
2. **Unificar truncado → `resume == fresh`.** Hoy el run fresco devuelve un `SubagentResult` con
   `stdout`/`stderr` completos, pero al journalizar se truncan con `truncate(..., MAX_JOURNALED_STREAM)`; el
   HIT de cache devuelve el objeto journaled (truncado). Resultado: fresco ≠ reanudado. **Fix:** aplicar la
   MISMA normalización al objeto que se DEVUELVE en el run fresco y al que se journaliza (truncar `stdout`/
   `stderr` del `SubagentResult` antes de retornarlo, y journalizar exactamente ese mismo objeto). Igual para
   `bash` si journaliza. Subir `JOURNAL_VERSION` 1→2.
3. **`loadJournal` tolerante pero diagnóstico.** Hoy hace `continue` ante cualquier línea malformada. Cambiar
   a: tolerar en silencio solo la ÚLTIMA línea (torn por crash); si hay una línea malformada en el medio,
   emitir un warning (es señal de corrupción real). Mantener `last-wins` por `(key, occ)`.

**Verificar B:** un run con `agents()` de varios subagentes de salida grande no corrompe `journal.jsonl`; y
el `output` de un HIT en resume es idéntico al del run fresco.

---

## Tarea A — `parallel()` + `agents({settle})` (null-on-failure)

**Por qué:** hoy `agents()` usa `Promise.all` (vía `mapLimit`): un solo fallo duro tumba todo el batch. Claude
resuelve cada rama a `null`. Esto habilita paneles adversariales / judge / multi-rama sin que 1 crash mate 19.

1. **`mapLimit(items, concurrency, signal, fn)`** (host): agregar opción de tolerancia, p.ej.
   `onError: "throw" | "null"` (default `"throw"` = comportamiento actual). En `"null"`: envolver
   `await fn(item, i)` en try/catch → `results[i] = null` en error. **`throwIfAborted(signal)` debe quedar
   FUERA del try** — cancelación/timeout global SIEMPRE propaga (no se traga como null).
2. **`agents(items, options)`** (host, `WorkflowRuntimeApi`): agregar `options.settle?: boolean`. Si `true`,
   pasar `onError:"null"` a `mapLimit`; el retorno pasa a `Array<SubagentResult | null>`. Sin `settle` =
   comportamiento actual (lanza). Actualizar el tipo del método.
3. **`parallel(thunks)`** (worker-side, en `WORKFLOW_WORKER_SOURCE`): agregar al `ctx` del worker una función
   `parallel(thunks)` donde `thunks` es un array de funciones que devuelven promesas. Ejecuta todas con un
   límite local de concurrencia (= `ctx.limits.concurrency`), `try/catch` → `null` por thunk, y **barrera**
   (espera todas). **No** agregar `parallel` a `allowedMethods`: los thunks son funciones que no cruzan el
   bridge; `parallel` solo coordina llamadas a `ctx.agent`/`ctx.bash` que sí cruzan (y cuya concurrencia real
   ya la acota el `agentSemaphore` del host). Documentar que es barrera y que filtra fallos a `null`.

**Verificar A:** `ctx.agents([...], { settle:true })` con un subagente que falla devuelve `null` en esa
posición y los demás resultados intactos; sin `settle`, sigue lanzando.

---

## Tarea C1 — guía de decisión (solo texto)

**Por qué:** la guía actual es una lista plana de disparadores de TAREA que invita al sobre-disparo; falta el
marco de DECISIÓN. El texto drop-in completo está en el plan, sección **"Authoring & Composición" → §2**
(`promptGuidelines` en 2a, `SKILL.md` en 2b, system-prompt del router en 2c). **Tomar ese texto, pero
RECORTADO al alcance de P0.**

**Scoping crítico (no enseñar APIs inexistentes):**
- **INCLUIR:** gate de 3 pasos (trivial / scout-inline-first / los 3 motivos exhaustividad·confianza·escala),
  scale-to-ask, no-silent-caps, y la guía de `ctx.agents({settle})` y `parallel()` (existen tras la Tarea A).
- **EXCLUIR (todavía no existen):** toda mención de `pipeline()`, `ctx.workflow()`, `ctx.budget`,
  `agent({schema})`/structured output, `agentType`/persona. Esas llegan en P1/P2; nombrarlas ahora enseñaría
  una API inexistente.

Aplicar en tres superficies:
1. `promptGuidelines` (en `registerTool`): reemplazar los bullets de decisión + agregar scale-to-ask,
   no-silent-caps y la guía `agents/agents({settle})/parallel`. **Mantener** los bullets existentes de
   resume-cache, trust y graph.
2. `skills/dynamic-workflows/SKILL.md`: agregar las secciones "When to build a workflow (decision)", "Scale
   effort to the ask", "No silent caps" y una versión de "Choosing a primitive" limitada a
   `agents`/`agents({settle})`/`parallel` (sin pipeline).
3. `makeAlwaysOnUltracodeSystemPrompt`: reescribir el cuerpo con el router (1 trivial gate · 2 scout inline ·
   3 los 3 motivos · 4 scale-to-ask); el párrafo de primitivas menciona SOLO `ctx.agents`/`parallel`.
4. `README.md` y `SKILL.md`: documentar `ctx.agents({settle})` y `parallel()`.

---

## Verificación (correr todo)

1. **Sintaxis:** `npx --yes esbuild extensions/dynamic-workflows.ts --bundle=false --outfile=/dev/null`
   (debe dar exit 0) tras CADA tarea.
2. **Tipos (recomendado antes de cerrar):**
   ```
   npm install --no-save @earendil-works/pi-coding-agent@0.80.2 @earendil-works/pi-ai@0.80.2 \
     @earendil-works/pi-tui@0.80.2 typebox typescript @types/node
   ```
   luego `npx tsc --noEmit` con un tsconfig mínimo (`module ESNext`, `moduleResolution Bundler`, `strict`,
   `skipLibCheck`, `types:["node"]`, `lib:["ES2023"]`). Solo deben aparecer errores ambientales si faltara
   algún tipo; **cero** errores en el código nuevo. `node_modules/` está gitignored.
3. **E2E (reusar el patrón del harness de resume):** cargar la extensión transpilada con un `pi`/`ctx`
   mockeado y `pi.exec` stubeado, y probar: (a) `agents({settle})` con un subagente que falla → `null` en su
   lugar y el resto OK; (b) `resume == fresh` (el `output` de un HIT idéntico al run fresco) tras unificar el
   truncado.
4. **Wiring:** `grep` de `AsyncMutex`, `settle`, `parallel`, `JOURNAL_VERSION` y de que la guía nueva NO
   nombre `pipeline`/`ctx.workflow`/`ctx.budget`/`schema`/`agentType`.

## Orden de trabajo

B → A → C1 (secuencial, esbuild tras cada una) → review adversarial (lentes: mutex/torn-write, semántica de
`settle`/null y propagación de abort, `resume==fresh`, y que la guía no prometa APIs inexistentes) → fix de
bloqueantes → verificación final + `git diff`.

## Después de P0
P1 (structured output con `--mode json`, pipeline, agentType) y P2 (budget, determinismo, ctx.workflow,
worktree) según el plan; sus decisiones ya están resueltas en §4 (solo D3 y D5 esperan visto bueno).
