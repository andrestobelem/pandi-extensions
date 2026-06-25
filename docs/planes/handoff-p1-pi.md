# Handoff a Pi — Implementar P1 (paridad con Claude Dynamic Workflows)

Brief para que Pi implemente **P1** (expresividad y tipado). **Requiere P0 ya hecho** (mutex del journal,
`agents({settle})`, `parallel()`). Plan completo y decisiones: `docs/planes/2026-06-25-paridad-claude-dynamic-workflows.md`
(§3 roadmap, §4 decisiones resueltas D1–D6). Todo en **`extensions/dynamic-workflows.ts`** salvo docs.

## Objetivo y alcance
P1 = cuatro tareas, **en este orden** (cada una sobre el mismo archivo, esbuild tras cada una):
**P1.0** migración a `--mode json` (keystone), **P1.1** structured output, **P1.2** `pipeline()`,
**P1.3** `agentType`/persona. **No** implementar P2 (budget, determinismo, ctx.workflow, worktree).

**Reglas duras:** no romper resume/ultracode; cambios aditivos/opt-in; no agregar deps (typebox ya está);
secuencial; confirmar anclajes con grep antes de editar.

---

## P1.0 — Migrar a `--mode json` + reconstruir `.output` (decisión D3; va PRIMERO)
Es el cambio más transversal y desbloquea P1.1 (parseo confiable) y P2.1 (budget). Formato exacto del JSON
Lines en `node_modules/@earendil-works/pi-coding-agent/docs/json.md`.

1. En `runSubagent`, agregar `--mode`, `"json"` a los args de `pi -p`.
2. Reemplazar el cálculo de `.output` (hoy `result.stdout.trim()`): parsear stdout como JSON Lines, tomar el
   último mensaje del assistant (`agent_end` → `messages[role="assistant"].content[type="text"].text`) y
   concatenar. **Fallback:** si el parse falla, usar `stdout` crudo + `ctx.log`/warning (no romper el run).
3. `.output` **no** entra en la cache-key → seguro para resume; igual subir `JOURNAL_VERSION` (cambia el
   shape del result journaled).
4. **Re-test obligatorio:** los 3 ejemplos (`repo-bug-hunt`, `deep-research`, `adversarial-plan-review`)
   deben producir `.output` equivalente al baseline (texto del assistant).

**Verificar P1.0:** `.output` de un subagente simple == el texto que daba antes; resume sin regresión.

---

## P1.1 — Structured output `agent({schema})` (decisiones D1 + D2)
- **D1 (forma de retorno):** extender `SubagentResult` con `data?: unknown` y `schemaOk?: boolean`. **No**
  agregar `ctx.agentData` todavía (queda como azúcar opcional posterior; `agents()` funciona sin variante).
- **D2 (validador):** usar **typebox** (`import { Value } from "typebox/value"`), **no** ajv.
- En `runSubagent`, si `options.schema` (un objeto **JSON Schema plano**):
  1. Inyectar instrucción + el schema vía `--append-system-prompt` (concatenar si el caller ya pasó uno).
  2. Extraer JSON de `.output` con `extractJsonCandidate` (parse directo → bloque ```json → balance de
     llaves), validar con `Value.Check(schema, data)`; si falla, reintentar hasta `schemaRetries`
     (default 2) realimentando `[...Value.Errors(schema, data)]`. Asignar `result.data` y `result.schemaOk`.
  3. `schemaOnInvalid: "throw" | "null"` (compone con `settle` de P0).
- `schema` **debe** quedar en la cache-key: es parte de `options`, así que **no excluirlo** en
  `sanitizeAgentOpts` (sí se excluyen name/timeoutMs/cache/prompt). Journalizar `result.data`.
- **Guía (ahora sí se puede):** documentar `agent(prompt, { schema })` en `promptGuidelines`/`SKILL.md`.

**Verificar P1.1:** un `agent({schema})` devuelve `result.data` validado; ante salida inválida reintenta y,
agotados los retries, respeta `schemaOnInvalid`.

---

## P1.2 — `pipeline(items, ...stages)` (gap C)
Worker-side, en el `ctx` de `WORKFLOW_WORKER_SOURCE`. **No** va en `allowedMethods` (las stages son funciones
que no cruzan el bridge; solo coordinan llamadas a `ctx.agent`/`ctx.bash`).
- `pipeline(items, ...stages)`: cada item fluye por TODAS las stages independientemente (cadena de promesas
  por item, sin barrera entre stages); todas arrancan, `Promise.allSettled`, `try/catch`→`null` por item.
- Cada stage callback recibe `(prevResult, originalItem, index)`.
- Concurrencia real acotada por el `agentSemaphore` del host; límite local opcional `inFlight`
  (default = `ctx.limits.concurrency`) solo para no crear demasiadas promesas (tope 4096 items por llamada).
- **Riesgo cache-key:** si dos items producen prompt idéntico, el `occ` se asigna por carrera → en resume el
  binding `occ↔item` puede variar. **Mitigación:** los scaffolds y la guía deben incluir el índice/id del
  item en el prompt (como `agents()` ya hace con `name: agent-${i+1}`). Documentarlo.
- **Guía:** completar la sección "Choosing a primitive" (pipeline-by-default + smell test de barrera) ahora
  que `pipeline`/`parallel` existen.

**Verificar P1.2:** un `pipeline` de 2 stages procesa items en streaming (un item puede estar en stage 2
mientras otro en stage 1); un fallo de stage deja ese item en `null` sin tumbar el resto.

---

## P1.3 — `agentType`/persona (gap D)
Host-side; usa solo flags que `pi -p` ya soporta (`--system-prompt`/`--append-system-prompt`/`--tools`/
`--model`/`--thinking`).
- `applyPersona(options, persona)`: mergea la persona como **DEFAULTS** (el override del caller gana;
  `appendSystemPrompt` se **concatena**) **ANTES de `computeCallKey`**. El `agentType` crudo **no** va en la
  key (quitarlo en `sanitizeAgentOpts`) — editar la persona invalida cache vía sus campos resueltos.
- Built-ins: `explore`/`reviewer`/`planner`/`implementer`/`researcher` (tools read-only + systemPrompt +
  model/thinking sensatos). Cargar `.pi/personas/*.json` solo si `ctx.isProjectTrusted()`.
- **Guía:** documentar `agent(prompt, { agentType: "reviewer" })`.

**Verificar P1.3:** `agent(p, { agentType:"reviewer" })` aplica los defaults; un override explícito gana.

---

## Verificación (P1 completa)
1. esbuild tras cada tarea: `npx --yes esbuild extensions/dynamic-workflows.ts --bundle=false --outfile=/dev/null`.
2. `tsc --noEmit` con peer deps (`npm install --no-save @earendil-works/pi-coding-agent@0.80.2 @earendil-works/pi-ai@0.80.2 @earendil-works/pi-tui@0.80.2 typebox typescript @types/node`) + tsconfig mínimo; cero errores en código nuevo.
3. E2E (patrón del harness de resume): (a) `--mode json` → `.output` equivalente al baseline; (b) `agent({schema})` → `data` validado + reintento; (c) `pipeline` streaming + null-on-failure; (d) persona aplica defaults.
4. Wiring por grep; y que la guía nueva ya pueda nombrar `schema`/`pipeline`/`agentType` (existen) pero **no** `ctx.workflow`/`ctx.budget` (siguen en P2).

## Orden
**P1.0 → P1.1 → P1.2 → P1.3** → review adversarial (lentes: reconstrucción de `.output` fiel, validación/retries de schema, streaming/cache-key de pipeline, merge de persona y cache-key) → fix → verificación final + `git diff`.

## Dependencias
Requiere P0. Deja listo para P2 el `--mode json` (P2.1 budget lo reusa) y la guía de primitivas
(P2 agrega composición/budget/determinismo/worktree). Ver `docs/planes/handoff-p2-pi.md`.
