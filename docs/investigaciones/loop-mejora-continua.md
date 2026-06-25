# Loop de mejora continua — log de progreso

Memoria externa del loop autónomo (estilo Reflexion). Una entrada por pasada. Conducido por
`docs/planes/loop-mejora-continua-prompt.md`. NO repetir caminos ya probados/descartados sin re-verificar.

---

## Pasada 1/8 — 2026-06-25

**Baseline:** `npm test` (tsc de las 4 extensiones) **verde** al iniciar.

**Archivos calientes detectados (no tocar):** `extensions/dynamic-workflows.ts` (mtime se movió de
07:28 → 07:36 durante esta pasada → OTRA sesión editándolo activamente) y `examples/workflows/{adversarial-plan-review,deep-research,repo-bug-hunt}.js` (ya modificados sin commitear al iniciar; no son míos). Respetados: no los toqué.

**Mejora ELEGIDA:** *e2e de comportamiento durable para las SAFETY GATES* de loop/plan.
Nuevo archivo (solo nuestro, no caliente): `examples/e2e/safety-gates.e2e.mjs`.

- **Problema observado (evidencia):** `package.json` `scripts.test` es SOLO `tsc --noEmit` → cero
  cobertura de comportamiento. Las partes más críticas de seguridad son predicados puros de gate:
  `plan.ts` `blockedReason`/`isMutatingBash` (read-only gate) y `loop.ts`
  `destructiveReason`/`isDestructiveBash`/`isUnsafeWritePath` + el clamp de `loop_schedule` a `[60,3600]`.
  Un regreso silencioso ahí = agujero de seguridad real (un loop autónomo corriendo `rm -rf`, o plan
  mode dejando pasar un `edit`) y `tsc` no lo detecta. Sesiones previas escribieron e2e equivalentes
  pero quedaron en el scratchpad desechable (evidencia: `loop-e2e.mjs`, `plan-e2e.mjs`, `goal-e2e.mjs`
  en el scratchpad; el plan de paridad referencia "el harness e2e (scratchpad) que ya valida resume")
  → se perdían entre sesiones, cero protección durable.
- **Por qué esta y no otras:** mayor valor/(esfuerzo·riesgo). Riesgo ~nulo (archivo nuevo, no toca el
  core caliente, no cambia runtime de las extensiones). Valor alto y durable: bloquea regresiones en
  los gates de seguridad para siempre, en repo, ejecutable desde checkout limpio.
- **Descartadas:** (i) proponer cambios al core `dynamic-workflows.ts` → es el archivo caliente, solo
  se permite PROPONER, y no había un defecto concreto observado que justificara una propuesta esta
  pasada; (ii) refactors cosméticos en loop/goal/plan → sin defecto observable, contarían como theater;
  (iii) cobertura e2e de `goal.ts` (verifier/`parseVerdict`) → buen candidato pero de mayor esfuerzo
  (spawnea subproceso `pi -p`); se difiere a próxima pasada para mantener UNA mejora coherente y acotada.

**Diseño del e2e:** self-bootstrapping. Esbuildea `extensions/{loop,plan}.ts` ACTUAL a un tempdir
(nunca copia stale), aliasando `typebox` y `@earendil-works/pi-coding-agent` a stubs locales (así corre
sin `npm install`), e importa el ESM real para manejar los handlers/tools registrados reales contra un
`pi`/`ctx` mockeado. Asserta el CONTRATO OBSERVABLE (block vs allow, delay clampeado), no copias de los
regex → trackea la fuente.

**Verificación adversarial + anti-theater:**
- 61/61 checks PASS contra la fuente real.
- **Fault-injection (prueba de que NO es theater):** copié loop.ts/plan.ts a un repo temporal, removí
  el patrón `\brm\b` de la copia de `plan.ts`, y la suite se puso ROJA (exit 1, falla exactamente
  `plan: BLOCKS bash "rm -rf x"`, 60/61). Con fuente limpia: verde. ⇒ detecta regresiones reales.
- Detecté y corregí un defecto propio: el proceso quedaba colgado tras el run verde (los loops dejan
  timers `setTimeout` vivos). Fix: `process.exit(0)` explícito en el camino de éxito. Re-verificado
  EXIT=0 limpio.

**Comandos de verificación (todos verdes):**
- `npm test` → EXIT 0 (tsc de las 4 extensiones).
- `node --check examples/e2e/safety-gates.e2e.mjs` → OK.
- `npx esbuild extensions/{loop,plan}.ts ...` → bundlean OK.
- `node examples/e2e/safety-gates.e2e.mjs` → `TOTAL: 61 passed, 0 failed`, EXIT 0.

**Archivos tocados (rutas absolutas):**
- NUEVO: `/Users/andrestobelem/ws/at/pi-dynamic-workflows/examples/e2e/safety-gates.e2e.mjs`
- NUEVO (este log): `/Users/andrestobelem/ws/at/pi-dynamic-workflows/docs/investigaciones/loop-mejora-continua.md`

**Tipo de cambio:** REAL (archivo nuevo, comportamiento verificado y fault-injected). No es propuesta.

**Pendientes para próximas pasadas:**
1. Extender la cobertura e2e a `goal.ts`: el verifier independiente y `parseVerdict` (parseo del
   veredicto del subagente skeptico — un parse erróneo = falso "done"). Mayor esfuerzo (subproceso).
2. Evaluar si conviene un runner único (`examples/e2e/run-all.mjs`) o wiring a un script npm — OJO:
   `package.json` NO está en la allowlist editable, así que el wiring a `npm test` requeriría decisión
   humana / handoff; por ahora los e2e se corren a mano (`node examples/e2e/*.e2e.mjs`).
3. Doc↔código: confirmar que README/SKILL.md mencionen cómo correr los e2e (gap menor).
4. Revisar si el plan de paridad tiene gaps NUESTROS (no del core caliente) aún sin implementar.

---

## Pasada 2/8 — 2026-06-25

**Baseline:** `npm test` (tsc de las 4 extensiones) **verde** al iniciar (EXIT 0).

**Archivos calientes detectados (no tocar):** `extensions/dynamic-workflows.ts` — sigue CALIENTE
(otra sesión activa: mtime/size se movieron DURANTE la pasada: 07:36/246371B → 07:39/246675B). Solo
proponer; no lo toqué. El resto de las extensiones nuestras estables y sin diff: `goal.ts` (mtime
06:27, +1h), `loop.ts` (06:32), `plan.ts` (06:48) → NO calientes. Mi único archivo nuevo está en
`examples/e2e/` (untracked, mío). Sin conflicto.

**Mejora ELEGIDA (pendiente #1 del log previo):** *e2e de comportamiento durable para el VERIFIER
INDEPENDIENTE de `goal.ts`* (donde un parse erróneo del veredicto = falso "done"). Nuevo archivo (solo
nuestro, no caliente): `examples/e2e/goal-verifier.e2e.mjs`.

- **Problema observado (evidencia):** `goal.ts:354 parseVerdict` + `goal.ts:388 runIndependentVerifier`
  + el state-machine de `beginIndependentVerification` (`goal.ts:650`) son el punto donde el paquete
  decide si un objetivo está realmente "done". Un regreso silencioso ahí (cerrar en un veredicto
  ambiguo/malformado, confiar en un eco del prompt que contiene `VERDICT: PASS`, o cerrar pese a exit≠0)
  = un FALSO "done" que cierra un goal NO verificado: exactamente la falla que el verifier existe para
  evitar. `tsc` no ve nada de esto (es lógica de strings + state machine). Sesiones previas escribieron
  un `goal-e2e.mjs` equivalente pero quedó en el scratchpad desechable (se pierde entre sesiones). Este
  es el commit durable que faltaba, registrado como pendiente #1 en la Pasada 1.
- **Por qué esta y no otras:** mayor valor/(esfuerzo·riesgo). Era el pendiente #1 explícito. Riesgo
  ~nulo (archivo nuevo, no toca el core caliente, no cambia runtime). El esfuerzo resultó S, no M: NO
  hizo falta spawnear `pi -p` real — el contrato OBSERVABLE se maneja mockeando `pi.exec` (la frontera
  del subproceso) y manejando los tools/comando reales; el subproceso real no aporta cobertura, solo
  fragilidad.
- **Descartadas:** (i) proponer al core `dynamic-workflows.ts` → sigue caliente y no observé un defecto
  concreto que justifique propuesta esta pasada; (ii) runner único / wiring a `npm test` (pendiente #2)
  → `package.json` NO está en la allowlist editable; requiere decisión humana/handoff, no se toca en
  autopiloto; (iii) doc de cómo correr e2e (pendiente #3) → gap menor, cosmético, no es alto valor.

**Diseño del e2e:** mismo patrón self-bootstrapping y probado de `safety-gates.e2e.mjs`. Esbuildea
`extensions/goal.ts` ACTUAL a tempdir (nunca stale), aliasa `typebox`/`@earendil-works/pi-coding-agent`
a stubs locales (corre sin `npm install`), y maneja el comando `/goal` + tool `goal_progress` REALES
contra un `pi`/`ctx` mockeado. Asserta el OUTCOME observable (el `gstatus` final persistido vía
`pi.appendEntry("goal-state", …)`: done / blocked / continue→pursuing), NO copias del regex. Cubre 7
escenarios: PASS-cierra, FAIL-itera-luego-bloquea-en-el-cap, malformado/ausente=FAIL conservador (6
sub-casos), **ataque de eco-de-prompt** (PASS aparece arriba como instrucción pero el veredicto final
es FAIL → no debe cerrar; control positivo simétrico: PASS final SÍ cierra pese al eco), exit≠0+PASS=FAIL,
timeout(killed)/throw=FAIL, y el primer `done` nunca cierra ni dispara el verifier (gate de dos pasos).

**Verificación adversarial + anti-theater:**
- 30/30 checks PASS contra la fuente real (EXIT 0).
- **Fault-injection (prueba de que NO es theater):** copié `goal.ts` a un repo temporal y reemplacé el
  cuerpo de `parseVerdict` por un parser NAIVE ("cualquier PASS en cualquier parte gana" — la regresión
  exacta contra la que el diseño protege). La suite se puso ROJA: **24/30, 6 fallas**, EXIT 1, fallando
  precisamente en los casos peligrosos: el eco-de-prompt cerró como `done`, el `VERDICTPASS` malformado
  y el "pass" en prosa cerraron como `done`. Con fuente limpia: verde. El control positivo (PASS final
  genuino) siguió cerrando en ambos → la suite distingue señal real de falso positivo. ⇒ detecta
  regresiones reales en el punto de seguridad.
- Sin regresión en la suite de la Pasada 1: `safety-gates.e2e.mjs` sigue 61/61.

**Comandos de verificación (todos verdes):**
- `npm test` → EXIT 0 (tsc de las 4 extensiones).
- `npx esbuild extensions/goal.ts --platform=node --format=esm --packages=external …` → bundlea OK.
- `node --check examples/e2e/goal-verifier.e2e.mjs` (y safety-gates) → OK.
- `node examples/e2e/goal-verifier.e2e.mjs` → `TOTAL: 30 passed, 0 failed`, EXIT 0.
- `node examples/e2e/safety-gates.e2e.mjs` → 61/61 (sin regresión).

**Archivos tocados (rutas absolutas):**
- NUEVO: `/Users/andrestobelem/ws/at/pi-dynamic-workflows/examples/e2e/goal-verifier.e2e.mjs`
- ESTE log: `/Users/andrestobelem/ws/at/pi-dynamic-workflows/docs/investigaciones/loop-mejora-continua.md`

**Tipo de cambio:** REAL (archivo nuevo, comportamiento verificado y fault-injected). No es propuesta.
**loop-until-dry counter:** 0 (esta pasada SÍ comprometió una mejora de alto valor). Pasadas usadas: 2/8.

**Pendientes para próximas pasadas (actualizado):**
1. ~~e2e de `goal.ts` verifier/parseVerdict~~ → HECHO esta pasada.
2. Runner único / wiring a `npm test`: sigue BLOQUEADO por allowlist (`package.json` no editable en
   autopiloto). Candidato a HANDOFF en docs/ si se quiere CI durable. No tocar `package.json` solo.
3. Doc↔código: README/SKILL.md no documentan cómo correr los e2e (`node examples/e2e/*.e2e.mjs`) — gap
   menor; evaluar si vale como mejora chica de docs (editable) o si es cosmético.
4. Cobertura e2e de comportamiento aún sin tocar en `loop.ts`/`goal.ts` MÁS ALLÁ de los gates/verifier:
   p.ej. el rehydrate de goals (`goal.ts:rehydrate`, recuperación tras reload — `verifying-independent`
   debe RE-correr el verifier) y el clamp de `waitSeconds` de `goal_progress` ([60,3600]). Re-verificar
   estado real antes de elegir; medir si hay defecto observable o si es theater.
5. Revisar si el plan de paridad (`docs/planes/2026-06-25-paridad-claude-dynamic-workflows.md`) tiene
   gaps NUESTROS (no del core caliente) aún sin implementar.

### Cierre de Pasada 2/8 — 2026-06-25 (finalización + re-verificación)

Revisiones adversariales R0 y R1: **APROBADAS, sin bloqueantes**. No hubo fixes que aplicar
(árbol ya verde). Re-verificación final de esta pasada de cierre (exit codes sin pipe):
- `npm test` (tsc 4 extensiones) → **EXIT 0** (verde).
- `npx esbuild extensions/goal.ts --platform=node --format=esm --packages=external` → **EXIT 0** (bundlea OK).
- `node --check examples/e2e/goal-verifier.e2e.mjs` y `…/safety-gates.e2e.mjs` → **OK**.
- `node examples/e2e/goal-verifier.e2e.mjs` → **30/30, EXIT 0**.
- `node examples/e2e/safety-gates.e2e.mjs` → **61/61, EXIT 0** (sin regresión).

Salvaguardas: core caliente `extensions/dynamic-workflows.ts` intacto por mí (mtime 07:47:08,
creció a 260687B durante la actividad de la otra sesión — sigue CALIENTE; solo proponer, no editar).
`git status --porcelain` de lo nuestro: solo untracked (`examples/e2e/`, este log,
`docs/planes/loop-mejora-continua-prompt.md`); `goal.ts`/`loop.ts`/`plan.ts` sin diff. Sin commit, sin push.

---

## Pasada 3/8 — 2026-06-25

**Baseline:** `npm test` (tsc de las 4 extensiones) **verde** al iniciar (EXIT 0).

**Archivos calientes detectados (no tocar):** `extensions/dynamic-workflows.ts` — SIGUE CALIENTE (otra
sesión activa: mtime se movió DURANTE la pasada, 07:47 → 07:55:22). Solo proponer; no lo toqué.
`goal.ts` (mtime 06:27:48, sin diff), `loop.ts` (06:32), `plan.ts` (06:48) → NO calientes. Mi único
archivo nuevo está en `examples/e2e/` (untracked, mío). Sin conflicto.

**Mejora ELEGIDA (pendiente #4 del log previo + candidato explícito de alto valor):** *e2e de
comportamiento durable para la REHIDRATACIÓN (recuperación tras crash/reload) de `goal.ts`* — el path
`rehydrate()` que dispara `session_start`. Nuevo archivo (solo nuestro, no caliente):
`examples/e2e/goal-rehydrate.e2e.mjs`.

- **Problema observado (evidencia):** `goal.ts:855 rehydrate` es el ÚNICO mecanismo que revive un goal
  vivo cuando el proceso reinicia, y su contrato es enteramente de COMPORTAMIENTO (invisible a `tsc`).
  El caso más consecuente: `goal.ts:905-909` — un snapshot en `verifying-independent` (un goal que
  crasheó EN MEDIO de la verificación independiente) debe RE-correr el subagente escéptico al recargar
  (su veredicto in-flight se perdió → se re-juzga, no se adivina). Una regresión silenciosa ahí = el
  goal o se cae en silencio o cierra SIN verificar — exactamente la falla que el verifier existe para
  evitar. Además: `stale`→`pursuing` (catch-up de UN tick, no ráfaga), `verifying`→`verifying` (el
  self-check sobrevive al reload), terminales (`done`/`blocked`/`stopped`) NO se recuperan
  (`goal.ts:868-875`), last-wins por goalId (`:862`), no-double-fire (`:877`), y `fork`→no-op
  (`:1161`). Cero cobertura e2e previa de todo esto.
- **Por qué esta y no otras:** mayor valor/(esfuerzo·riesgo). Era el pendiente #4 explícito y uno de los
  candidatos de alto valor nombrados. Riesgo ~nulo (archivo nuevo, no toca el core caliente, no cambia
  runtime). Esfuerzo S/M: reusa el patrón self-bootstrapping ya probado; maneja el handler real de
  `session_start` contra un `pi`/`ctx` mockeado con `sessionManager.getEntries()` devolviendo snapshots
  `goal-state` fabricados (la entrada real del reload).
- **Descartadas:** (i) proponer al core `dynamic-workflows.ts` → sigue caliente, sin defecto concreto
  observado esta pasada que justifique propuesta; (ii) e2e de loop fijo/cron/FIFO/watchdog/clamp → buen
  candidato pero MAYOR esfuerzo (timers/cron, multi-loop FIFO); se difiere para mantener UNA mejora
  acotada y porque la rehidratación de goal era el pendiente #4 con evidencia directa; (iii) coherencia
  doc↔código SKILL.md → gap menor/cosmético, no alto valor; (iv) wiring a `npm test` → `package.json`
  fuera de allowlist (bloqueado, candidato a handoff).

**Diseño del e2e:** mismo patrón self-bootstrapping de safety-gates/goal-verifier. Esbuildea
`extensions/goal.ts` ACTUAL a tempdir (nunca stale), aliasa `typebox`/SDK a stubs locales (corre sin
`npm install`), maneja el handler REAL de `session_start` y asserta el OUTCOME observable: qué goals se
activan, en qué `gstatus`, si re-spawnea el verifier (`pi.exec`), si re-inyecta wake
(`pi.sendUserMessage`), y la disposición final persistida. Para `stale`/`verifying` usa `nextFireAt` en
el PASADO para que el tick de catch-up dispare y pruebe que el goal está GENUINAMENTE activo (persiste
iteración+1 y re-inyecta UNA sola vez), sin escape tautológico. 8 escenarios / **31 checks**:
verifying-independent RE-corre verifier (PASS→done; FAIL bajo cap→continue; FAIL en cap→blocked; nunca
falso done); stale→pursuing (un solo wake); verifying→verifying (no downgrade, no verifier); terminales
NO recuperados (no exec/no wake/no persist nuevo); last-wins por goalId (ambas direcciones); fork=no-op;
junk/foráneo/malformado ignorado sin crash; no-double-fire en segundo session_start.

**Verificación adversarial + anti-theater:**
- 31/31 checks PASS contra la fuente real (EXIT 0).
- **Fault-injection #1 (prueba de que NO es theater):** copié `goal.ts` a un repo temporal y REMOVÍ la
  rama `verifying-independent` de `rehydrate` (re-armar timer normal en vez de `beginIndependentVerification`
  — la regresión silenciosa exacta). La suite se puso ROJA: **25/31, 6 fallas**, fallando precisamente
  los checks del contrato `verifying-independent` (no re-spawnea verifier, no cierra/blockea, last-wins
  re-run, junk-only-valid-recovers). Con fuente limpia: verde. ⇒ detecta la regresión más peligrosa.
- **Fault-injection #2 (hallazgo honesto sobre alcance):** inyecté "recuperar TODO, incl. terminales".
  La suite siguió VERDE (31/31). Motivo real y correcto: un snapshot terminal tiene `nextFireAt:null` y
  `fireGoal` (`goal.ts:575`) retorna de inmediato para todo status ≠ pursuing/verifying → la
  sobre-recuperación es OBSERVABLEMENTE INERTE (cero exec/wake/persist). Mis checks terminales pinnean el
  contrato OBSERVABLE (un goal terminado no produce actividad), que se sostiene; NO pinnean el filtro
  interno. Limitación documentada, no oculta: el harness mockeado no ve `activeGoals` directamente, y la
  garantía observable (terminado = inerte) es la que importa para el usuario.
- Sin regresión en las suites previas: `goal-verifier.e2e.mjs` 30/30, `safety-gates.e2e.mjs` 61/61.

**Comandos de verificación (exit codes sin pipe, todos verdes):**
- `npm test` → **EXIT 0**.
- `npx esbuild extensions/goal.ts --platform=node --format=esm --packages=external` → **EXIT 0**.
- `node --check examples/e2e/{goal-rehydrate,goal-verifier,safety-gates}.e2e.mjs` → **OK**.
- `node examples/e2e/goal-rehydrate.e2e.mjs` → **31/31, EXIT 0**.
- `node examples/e2e/goal-verifier.e2e.mjs` → **30/30, EXIT 0** (sin regresión).
- `node examples/e2e/safety-gates.e2e.mjs` → **61/61, EXIT 0** (sin regresión).

**Archivos tocados (rutas absolutas):**
- NUEVO: `/Users/andrestobelem/ws/at/pi-dynamic-workflows/examples/e2e/goal-rehydrate.e2e.mjs`
- ESTE log: `/Users/andrestobelem/ws/at/pi-dynamic-workflows/docs/investigaciones/loop-mejora-continua.md`

**Tipo de cambio:** REAL (archivo nuevo, comportamiento verificado y fault-injected). No es propuesta.
**loop-until-dry counter:** 0 (esta pasada SÍ comprometió una mejora de alto valor). Pasadas usadas: 3/8.
**Salvaguardas:** core caliente `dynamic-workflows.ts` intacto por mí (mtime se movió a 07:55:22 por la
otra sesión — sigue CALIENTE). Único cambio mío: untracked `examples/e2e/goal-rehydrate.e2e.mjs`.
`goal.ts`/`loop.ts`/`plan.ts` sin diff. Sin commit, sin push.

**Pendientes para próximas pasadas (actualizado):**
1. ~~e2e rehydrate de goal (verifying-independent re-corre verifier)~~ → HECHO (Pasada 3).
2. ~~e2e de comportamiento de `loop.ts` (cadencia fija, FIFO multi-loop, watchdog)~~ → HECHO (Pasada 4).
3. Wiring a `npm test` (runner único): sigue BLOQUEADO por allowlist (`package.json` no editable en
   autopiloto). Candidato a HANDOFF en docs/ si se quiere CI durable.
4. Doc↔código: README/SKILL.md no documentan cómo correr los e2e (`node examples/e2e/*.e2e.mjs`) — gap
   menor; evaluar como mejora chica de docs (editable) o cosmético.
5. Revisar gaps NUESTROS del plan de paridad (`docs/planes/2026-06-25-paridad-claude-dynamic-workflows.md`)
   no del core caliente.
6. Cobertura e2e aún sin tocar en `loop.ts`: caps gate (maxIterations / wall-clock / context-percent
   detienen el loop con status "done"), pause/resume (preservar remaining delay; resume dynamic vs fixed),
   rehydrate de loop (stale→running con un solo catch-up tick, paused se mantiene paused, last-wins
   JSONL-vs-sidecar). El verifier de goal y la rehidratación de goal ya están cubiertos; esto es el
   análogo para loop.

---

## Pasada 4/8 — 2026-06-25

**Baseline:** `npm test` (tsc de las 4 extensiones) **verde** al iniciar (EXIT 0).

**Archivos calientes detectados (no tocar):** `extensions/dynamic-workflows.ts` — SIGUE CALIENTE (otra
sesión activa: mtime se movió DURANTE la pasada, 07:56:49 → 08:00:42). Solo proponer; no lo toqué.
`goal.ts` (mtime 06:27:48, sin diff), `loop.ts` (06:32:56, sin diff), `plan.ts` (06:48:10, sin diff) →
NO calientes. Mi único archivo nuevo está en `examples/e2e/` (untracked, mío). Sin conflicto.

**Mejora ELEGIDA (pendiente #2 del log previo + candidato explícito de alto valor):** *e2e de
comportamiento durable para el MOTOR DE PROGRAMACIÓN de `loop.ts`* — la parte que decide CUÁNDO y EN QUÉ
ORDEN disparan las iteraciones autónomas, distinta de los GATES (ya cubiertos por safety-gates) y del
clamp de `loop_schedule` (ya cubierto por safety-gates — NO duplicado aquí). Nuevo archivo (solo nuestro,
no caliente): `examples/e2e/loop-behavior.e2e.mjs`.

- **Aclaración del prompt vs. código (evidencia):** el candidato nombraba "fijo/cron". El código NO tiene
  cron: la cadencia es fixed-interval (`^\d+(s|m|h)$`, `loop.ts:106 INTERVAL_RE` + `:271 parseInterval`)
  o dynamic (model-paced). Cubrí lo que EXISTE de verdad, no un cron inexistente.
- **Problema observado (evidencia):** cuatro contratos puramente de COMPORTAMIENTO, invisibles a `tsc`:
  (i) **FIFO multi-loop** (`loop.ts:466 drainWakeQueue` + `:477` gate one-turn-at-a-time + `:496` return):
  con N loops vivos, EXACTAMENTE UNA iteración de autopiloto a la vez; el resto encola FIFO y drena en
  orden de llegada en `agent_end` (`:1521-1524`). Si se rompe → N loops abren turno en el MISMO turno
  humano y el gate destructivo mis-fire / los turnos compiten por la sesión. (ii) **fixed-mode NO-OP de
  `loop_schedule`** (`:1376`): en fixed el usuario es dueño de la cadencia → `loop_schedule` debe ser un
  no-op informativo (no tocar timer/nextFireAt); si se rompe, el modelo reprograma una cadencia fija.
  (iii) **watchdog anti-zombie** (`:1106 watchdogSweep`, backstop 25h `:113`): un loop running pasado el
  backstop se force-stopea (`done`); un loop PAUSED de la misma edad se PERDONA deliberadamente (`:1109`,
  un paused no es zombie). (iv) **clamp del parser de intervalo** (`:278`, `[1s,24h]`) + rechazo de
  tokens no-match → dynamic (un `0s` NO debe volverse busy-spin; un typo no debe degradar silenciosamente
  fixed→dynamic). Cero cobertura e2e previa de TODO esto.
- **Por qué esta y no otras:** mayor valor/(esfuerzo·riesgo). Era el pendiente #2 explícito y candidato
  de alto valor nombrado. Riesgo ~nulo (archivo nuevo, no toca core caliente, no cambia runtime). Esfuerzo
  S/M: reusa el patrón self-bootstrapping ya probado; clave de diseño → NO esperar timers reales: el
  PRIMER wake de cada loop dispara SÍNCRONO dentro de `startLoop` (`fireWake` directo, no vía setTimeout),
  y `agent_end` libera el gate y drena el siguiente wake de forma síncrona; el watchdog se prueba
  backdateando `startedAt` vía la entrada de `rehydrate` (`session_start`). Nunca se duerme un setTimeout
  de ≥60s.
- **Descartadas:** (i) proponer al core `dynamic-workflows.ts` → sigue caliente, sin defecto concreto
  observado esta pasada; (ii) duplicar el clamp de `loop_schedule` o los gates destructivos → YA cubierto
  por safety-gates (sería theater); (iii) caps gate / pause-resume / rehydrate de loop → buenos candidatos
  pero se difieren para mantener UNA mejora acotada (registrados como pendiente #6); (iv) wiring a
  `npm test` → `package.json` fuera de allowlist (bloqueado, candidato a handoff); (v) doc SKILL.md → gap
  menor/cosmético.

**Diseño del e2e:** mismo patrón self-bootstrapping de safety-gates/goal-*. Esbuildea `extensions/loop.ts`
ACTUAL a tempdir (nunca stale), aliasa `typebox`/SDK a stubs locales (corre sin `npm install`), maneja el
comando `/loop` + tool `loop_schedule` + handlers `agent_end`/`session_start` REALES contra un `pi`/`ctx`
mockeado. El comando `/loop` devuelve `Promise<void>` (no expone el `ActiveLoop`), así que cada loop se
resuelve por su EFECTO OBSERVABLE: el `loopId` del snapshot `loop-state` más nuevo persistido vía
`appendEntry`. Asserta el contrato observable (qué wake se entrega y en qué orden, status persistido,
intervalMs clampeado), nunca copias de los internals. 7 escenarios / **37 checks**: FIFO (A entrega 1,
B/C encolan, drenan B→C en orden, queue vacía no re-entrega), no-delivery-while-busy (isIdle=false retiene
hasta agent_end idle), refuse en print mode (no persist/no wake), fixed mode + no-op de loop_schedule
(con control positivo: dynamic SÍ re-arma 1800), watchdog healthy-untouched, watchdog aged-zombie-killed +
paused-spared + healthy-untouched vía rehydrate, parser/clamp de intervalo (30s/5m/2h, 48h→24h, 0s/typo
→dynamic).

**Verificación adversarial + anti-theater (fault-injection, 3 faults en repo temporal):**
- 37/37 checks PASS contra la fuente real (EXIT 0). Copia limpia relocalizada en repo temporal: verde
  (control — confirma que el harness sigue la fuente relocalizada, no una stale).
- **Fault #1 (romper FIFO):** removí el gate one-turn-at-a-time (`:477`) y el `return` de entrega-única
  (`:496`) → `drainWakeQueue` entrega TODO de una. Suite ROJA: **35/37, 2 fallas**, EXACTAMENTE los 2
  checks FIFO (`delivered=3` en vez de escalonado 1→2→3). Limpio: verde.
- **Fault #2 (romper fixed no-op):** cambié `if (loop.mode === "fixed")` (`:1376`) a `if (false)` → el
  modelo reprograma un loop fijo. Suite ROJA: **34/37, 3 fallas**, EXACTAMENTE los 3 checks de fixed-no-op
  (`loop_schedule` re-armó con `delaySeconds:90`, mutó `nextFireAt`). El control positivo dynamic siguió
  verde → la suite distingue no-op de re-arm. Limpio: verde.
- **Fault #3 (deshabilitar watchdog):** inserté `return 0` al inicio de `watchdogSweep` (`:1106`). Suite
  ROJA: **35/37, 2 fallas**, EXACTAMENTE los 2 checks de kill-de-zombie (el zombie envejecido siguió vivo,
  `status=undefined`); paused-spared y healthy-untouched siguieron verdes (no se tornan falsos-positivos
  por la ausencia del kill). Limpio: verde.
- Cada fault tripó PRECISAMENTE los checks que protegen ese comportamiento y nada más; copia limpia
  byte-idéntica a la fuente (`diff` vacío) y verde. ⇒ detección de regresión dirigida, no theater.
- Sin regresión en las suites previas: `safety-gates` 61/61, `goal-verifier` 30/30, `goal-rehydrate` 31/31.

**Comandos de verificación (exit codes sin pipe, todos verdes):**
- `npm test` → **EXIT 0**.
- `npx esbuild extensions/loop.ts --platform=node --format=esm --packages=external` → **EXIT 0**.
- `node --check examples/e2e/{loop-behavior,safety-gates,goal-verifier,goal-rehydrate}.e2e.mjs` → **OK**.
- `node examples/e2e/loop-behavior.e2e.mjs` → **37/37, EXIT 0**.
- `node examples/e2e/safety-gates.e2e.mjs` → **61/61, EXIT 0** (sin regresión).
- `node examples/e2e/goal-verifier.e2e.mjs` → **30/30, EXIT 0** (sin regresión).
- `node examples/e2e/goal-rehydrate.e2e.mjs` → **31/31, EXIT 0** (sin regresión).

**Archivos tocados (rutas absolutas):**
- NUEVO: `/Users/andrestobelem/ws/at/pi-dynamic-workflows/examples/e2e/loop-behavior.e2e.mjs`
- ESTE log: `/Users/andrestobelem/ws/at/pi-dynamic-workflows/docs/investigaciones/loop-mejora-continua.md`

**Tipo de cambio:** REAL (archivo nuevo, comportamiento verificado y fault-injected x3). No es propuesta.
**loop-until-dry counter:** 0 (esta pasada SÍ comprometió una mejora de alto valor). Pasadas usadas: 4/8.
**Salvaguardas:** core caliente `dynamic-workflows.ts` intacto por mí (mtime 08:00:42 por la otra sesión —
sigue CALIENTE; solo proponer). `goal.ts`/`loop.ts`/`plan.ts` sin diff (`git diff --stat` vacío). Único
cambio mío: untracked `examples/e2e/loop-behavior.e2e.mjs`. Sin commit, sin push.

**DECISIÓN:** continue. Próximo pendiente de mayor valor: pendiente #6 — e2e de caps gate / pause-resume /
rehydrate de `loop.ts` (el análogo de loop a la rehidratación de goal ya cubierta).

### Cierre de Pasadas 3/8 y 4/8 — 2026-06-25 (finalización + re-verificación)

Revisiones adversariales R0 y R1 de ambas pasadas: **APROBADAS, sin bloqueantes, sin regresiones**.
No hubo fixes que aplicar (árbol ya verde; ambos e2e nuevos ya commiteables como untracked). Re-verificación
final de esta pasada de cierre (exit codes directos, sin pipe):
- `npm test` (tsc 4 extensiones) → **EXIT 0** (verde).
- `npx esbuild extensions/goal.ts …` → **EXIT 0**; `npx esbuild extensions/loop.ts …` → **EXIT 0** (bundlean OK a scratchpad).
- `node --check` de `{goal-rehydrate,loop-behavior,safety-gates,goal-verifier}.e2e.mjs` → **OK** (los 4).
- `node examples/e2e/goal-rehydrate.e2e.mjs` → **31/31, EXIT 0**.
- `node examples/e2e/loop-behavior.e2e.mjs` → **37/37, EXIT 0**.
- Sin regresión: `node examples/e2e/safety-gates.e2e.mjs` → **61/61, EXIT 0**; `node examples/e2e/goal-verifier.e2e.mjs` → **30/30, EXIT 0**.

**Salvaguardas (re-confirmadas en esta finalización):** core caliente `extensions/dynamic-workflows.ts`
intacto por mí (mtime estable 08:00:42, sin diff — `git diff --stat extensions/` vacío, EXIT 0; la otra
sesión parece haber pausado). `goal.ts`/`loop.ts`/`plan.ts` sin diff (solo leídos por esbuild). `package.json`
sin tocar. Mis únicos cambios: untracked `examples/e2e/goal-rehydrate.e2e.mjs` (Pasada 3) +
`examples/e2e/loop-behavior.e2e.mjs` (Pasada 4) + estas entradas de log. NO son míos (no tocados): `docs/README.md`
(M, ajeno), `examples/e2e/dynamic-workflow-composition.e2e.mjs` (untracked, mtime 08:09, ajeno),
`package-lock.json`, `.loop-e2e-build.mjs`, los `docs/planes/handoff-*.md`. Sin commit, sin push, nada irreversible.

**dry-counter:** 0 (ambas pasadas comprometieron mejora real de alto valor, fault-injected). Pasadas usadas: 4/8.
**VEREDICTO:** continue. Próximo pendiente de mayor valor: pendiente #6 — e2e de caps gate (maxIterations /
wall-clock / context-percent → status "done") + pause/resume (preservar remaining delay; resume dynamic vs
fixed) + rehydrate de `loop.ts` (stale→running un solo catch-up tick, paused se mantiene paused, last-wins
JSONL-vs-sidecar). Es el análogo de loop a la rehidratación de goal ya cubierta.

---

## Pasada 5/8 — 2026-06-25 — MATERIALIZAR LA COMPOSICIÓN (ctx.workflow)

**Baseline:** `npm test` (tsc de las 4 extensiones) **verde** al iniciar (EXIT 0).

**Archivos calientes / ajenos detectados (no tocar):** `extensions/dynamic-workflows.ts` (mtime 08:00:42,
estable — la otra sesión parece pausada, pero el archivo sigue siendo del core: solo proponer, no editar).
**HALLAZGO CLAVE:** la otra sesión YA materializó la MEJORA A textual del prompt: ya existen
`examples/workflows/lib/verify-claims.js` (07:58) y `examples/workflows/adaptive-composition-driver.js`
(07:57) — exactamente el `lib/verify-claims` + driver que pedía el prompt. Tocarlos o duplicarlos sería
colisión/theater. Respetados: NO los toqué (mtimes intactos al cerrar).

**Mejora ELEGIDA (re-encuadre honesto):** dado que MEJORA A ya estaba hecha por la otra sesión, materialicé
la COMPOSICIÓN con el SEGUNDO building block que el propio prompt ofrecía como alternativa: `lib/rank-candidates`
(contrato distinto: ORDENA en vez de FILTRAR). Tres archivos nuevos, todos míos, ninguno caliente:
- `examples/workflows/lib/rank-candidates.js` — sub-workflow REUSABLE bajo `lib/`.
  Contrato `{ candidates:[{id?,text}], rubric?, goal?, jurors?, keepTop? } -> { ranked(best-first), best,
  dropped, coverage }`. Jurado independiente (`ctx.agents(settle:true)` + `schema`), promedio clampeado a
  [0,10], orden determinista con tie-break por id, cap de jurados a `ctx.limits.concurrency`, drop de
  candidatos vacíos/no-texto. Coherente con el caso `tournament` del catálogo ("Rank candidate designs").
- `examples/workflows/composition-rank-driver.js` — DRIVER: descubre candidatos (agente generador) y delega
  la fase reusable vía `ctx.workflow("lib/rank-candidates", {...})`, luego sintetiza al ganador.
- `examples/e2e/composition-rank.e2e.mjs` — e2e durable que prueba RESOLUBILIDAD + COHERENCIA.

- **Por qué esta y no otra:** mayor valor/(esfuerzo·riesgo) SIN colisión ni duplicación. El prompt nombraba
  `lib/verify-claims` O `lib/rank-candidates`; el primero ya estaba tomado por la otra sesión, así que el
  segundo es el aporte genuinamente aditivo. Riesgo ~nulo (3 archivos nuevos untracked, no toca core caliente
  ni runtime). Además queda registrado en el catálogo del core un hueco real: el recipe `composition-driver`
  (`dynamic-workflows.ts:658`) hardcodea SOLO `lib/verify-claims`; este segundo lib demuestra que la
  composición es un patrón general, no un one-off (candidato a PROPUESTA futura: añadir un recipe
  `rank-candidates-lib`/segundo driver al catálogo — no editado por ser core).
- **Coherencia de resolución (clave del prompt):** `ctx.workflow(name)` resuelve desde el DIRECTORIO DE
  WORKFLOWS del runtime (`.pi/workflows` o global), NO desde `examples/`. Ambos archivos llevan cabecera que
  explica el patrón y CÓMO correrlo (copiar `lib/` + driver a `.pi/workflows/` preservando la ruta `lib/`).
  El e2e PRUEBA esto de verdad: copia los archivos REALES de `examples/` a `.pi/workflows/` de un proyecto
  temporal y corre la extensión REAL.

**Diseño del e2e (mismo patrón self-bootstrapping ya probado):** esbuildea `dynamic-workflows.ts` ACTUAL a
tempdir (nunca stale), aliasa typebox/SDK/tui a stubs (corre sin `npm install`), instala los archivos REALES
de `examples/workflows/` en `.pi/workflows/{,lib/}` de un proyecto temporal, y maneja el tool `dynamic_workflow`
REAL con `action:"run"`. La frontera del subproceso del agente se mockea vía `PI_DYNAMIC_WORKFLOWS_PI_COMMAND`
(fake-pi que emite UNA línea JSON-mode `message_update`; ramifica por el prompt: generador→array de candidatos,
jurado→`{score}` determinista, síntesis→prosa). **13 checks / 3 escenarios:** (1) resuelve+rankea (parent ok,
best-first, best===ranked[0], peor último, scores numéricos, coverage, artifact de la lib aterriza en el runDir
COMPARTIDO, eventos workflow start/end `lib/rank-candidates`); (2) drop de candidato en blanco vía llamada
DIRECTA a la lib (otro parent mínimo → prueba resolución sin el generador); (3) **control NEGATIVO:** si se
aplana la ruta `lib/` (archivo en la raíz en vez de bajo `lib/`), `ctx.workflow("lib/rank-candidates")` NO
resuelve y el run FALLA con `Workflow not found: lib/rank-candidates` → prueba que la instrucción de layout
de la cabecera es load-bearing, no decorativa.

**Verificación adversarial + anti-theater + DEFECTO PROPIO ENCONTRADO Y CORREGIDO:**
- **Defecto real hallado por el e2e (no theater):** mi primera versión devolvía `best: ranked[0]` (MISMA
  referencia que dentro de `ranked`). El serializador del runtime (writeArtifact/`ctx.compact`) emite
  `"[Circular]"` para la segunda aparición del objeto compartido → `best` quedaba inutilizable (`"[Circular]"`)
  en el artifact y en lo que ve el agente de síntesis. El e2e lo destapó (FAILs en `best===ranked[0]` y en el
  artifact de la lib). **Fix:** `best` es ahora una COPIA SHALLOW (`{...finalRanked[0]}`) → sin referencia
  compartida, sin `[Circular]`. Re-verificado verde.
- **Fault-injection #1 (orden):** invertí el comparador (`a.score-b.score`, worst-first). Suite ROJA:
  **10/13, 3 fallas**, EXACTAMENTE los checks de orden (best-first, peor-último, best de la lib); resolución/
  composición/dropped/negativo siguieron verdes. Fuente limpia: 13/13.
- **Fault-injection #2 (el bug [Circular]):** reintroduje `best: ranked[0]` (misma ref). Suite ROJA:
  **11/13, 2 fallas**, EXACTAMENTE `best===ranked[0]` y el artifact de la lib. Fuente limpia: 13/13.
- Cada fault tripó PRECISAMENTE los checks que protegen ese contrato y nada más ⇒ detección dirigida, no theater.
- Sin regresión en TODAS las suites previas (corridas, exit codes directos): composition-rank 13/13,
  dynamic-workflow-composition 16/16, safety-gates 61/61, goal-verifier 30/30, goal-rehydrate 31/31,
  loop-behavior 37/37 — todas EXIT 0.

**Comandos de verificación (todos verdes):**
- `npm test` → **EXIT 0**.
- `node --check examples/workflows/lib/rank-candidates.js` + `…/composition-rank-driver.js` +
  `examples/e2e/composition-rank.e2e.mjs` → **OK** (los 3).
- `node examples/e2e/composition-rank.e2e.mjs` → **13/13, EXIT 0**.
- Regresión: dynamic-workflow-composition 16/16, safety-gates 61/61, goal-verifier 30/30, goal-rehydrate
  31/31, loop-behavior 37/37 — todas EXIT 0.

**Archivos tocados (rutas absolutas):**
- NUEVO: `/Users/andrestobelem/ws/at/pi-dynamic-workflows/examples/workflows/lib/rank-candidates.js`
- NUEVO: `/Users/andrestobelem/ws/at/pi-dynamic-workflows/examples/workflows/composition-rank-driver.js`
- NUEVO: `/Users/andrestobelem/ws/at/pi-dynamic-workflows/examples/e2e/composition-rank.e2e.mjs`
- ESTE log.

**Tipo de cambio:** REAL (3 archivos nuevos; defecto propio hallado+corregido; comportamiento verificado y
fault-injected x2). No es propuesta. **Propuesta diferida (no editada):** añadir el segundo lib/driver al
catálogo de recipes del core `dynamic-workflows.ts` (`composition-driver` hoy solo cita `lib/verify-claims`).
**dry-counter:** 0 (pasada de alto valor). Pasadas usadas: 5/8.
**Salvaguardas:** core caliente `dynamic-workflows.ts` intacto por mí (mtime 08:00:42 sin cambio; `git diff
--stat` de extensiones VACÍO). `lib/verify-claims.js`/`adaptive-composition-driver.js` de la otra sesión
intactos (mtimes 07:58/07:57). `package.json` sin tocar. Sin commit, sin push, nada irreversible.

---

## Pasada 6/8 — 2026-06-25 — COMPOSICIÓN: contratos de FALLA + RECURSIÓN (MEJORA B)

**Baseline:** `npm test` (tsc de las 4 extensiones) **verde** al iniciar (EXIT 0).

**Archivos calientes / ajenos detectados (no tocar):** `extensions/dynamic-workflows.ts` SIGUE CALIENTE —
la otra sesión lo editó ACTIVAMENTE durante esta pasada (mtime 10:40:25 → 10:41:08 → 10:43:13; tamaño
278489B → 279649B). Solo leído para entender contratos; NO editado por mí (`git diff --stat` de extensiones
sin `dynamic-workflows.ts` al cerrar — la otra sesión committeó/revirtió su WIP). `examples/e2e/dynamic-workflow-composition.e2e.mjs`
(ajeno, otra sesión, mtime 08:09) y los `examples/workflows/adaptive-{router,plan-and-execute,tree-of-thoughts,tournament}.js`
(ajenos, 07:19-07:21) → NO tocados. Mis archivos de Pasada 5 (`lib/rank-candidates.js`, `composition-rank-driver.js`,
`composition-rank.e2e.mjs`) intactos.

**Mejora ELEGIDA (MEJORA B, opción ii del prompt, RE-ENCUADRADA para no colisionar):** e2e durable nuevo
`examples/e2e/composition-failure-recursion.e2e.mjs` que pinea DOS contratos de `ctx.workflow()` que el e2e
de composición existente (ajeno) NO cubre. **Decisión clave:** el prompt nombraba "rechazo de recursión depth-1"
y "cambiar código del hijo re-ejecuta en resume" como opciones — pero AMBAS ya están cubiertas por el e2e ajeno
(`scenarioDepthLimit` cubre el guard de ANIDAMIENTO parent→child→grandchild; `scenarioChildCodeHashNamespacesResumeCache`
cubre el resume cache). Editar ese archivo ajeno sería colisión con la otra sesión. Así que construí un archivo
EXCLUSIVAMENTE MÍO que cubre los huecos reales restantes:
- **Contrato 1 — recursión DIRECTA (auto-llamada):** un workflow que llama `ctx.workflow("<su propio nombre>")`
  NUNCA baja un nivel, así que el guard de anidamiento (`composition depth limit is 1`) jamás dispara. Un check
  SEPARADO de igualdad de path en `runSubworkflow` (`dynamic-workflows.ts:5433`) lo rechaza con un mensaje
  DISTINTO (`refused recursive call ... may not call their parent`). Sin ese check = recursión infinita hasta
  reventar stack/limits. Cero cobertura previa.
- **Contrato 2 — propagación de FALLA del sub-workflow + evento `phase:"error"`:** cuando un hijo lanza, (a) la
  falla propaga al padre como throw normal (recuperable con try/catch), y (b) el run registra un evento
  `workflow phase:"error"` con `ok:false` y el mensaje (`dynamic-workflows.ts:5448-5453`). El e2e ajeno solo
  asserta el evento de ÉXITO (`phase:"end"`/`ok:true`). Una regresión que tragara el error del hijo (return
  undefined en vez de rethrow) = padre que continúa en silencio tras un sub-paso fallido. Cero cobertura previa.

- **Por qué esta y no la opción (i):** reescribir router/plan/tot/tournament como composición habría tocado
  archivos AJENOS (otra sesión, 07:19-07:21) y, peor, `adaptive-tournament.js` hace eliminación PAIRWISE
  (semántica distinta a `lib/rank-candidates`, que es scoring absoluto) → la reescritura cambiaría la semántica,
  no sería "más limpia". Ambos targets del prompt (el e2e de composición ajeno, los ejemplos inline ajenos)
  estaban tomados por la otra sesión → el aporte genuinamente aditivo y sin-colisión es un e2e nuevo propio.

**Hallazgo de diseño (corregido en el e2e, no es defecto del core):** `action:"run"` NO devuelve `{ok:false}`
en falla; LANZA `formatRunSummary(result)` (`dynamic-workflows.ts:5957`). Mi primera versión leía
`response.details.result.ok` y explotaba con EXIT 2. Fix: helper `runExpectingFailure` que captura el throw y
parsea el surface OBSERVABLE (`Artifacts: <runDir>` + `Error: <msg>`) que ve el agente/usuario — y desde ese
runDir lee `events.jsonl`. Esto es exactamente lo que enfrenta un consumidor real del tool.

**Verificación adversarial + anti-theater (fault-injection en repo temporal, control byte-idéntico):**
- 16/16 contra la fuente real (EXIT 0). Copia limpia relocalizada en repo temporal: VERDE (`diff` vacío vs
  fuente → el harness sigue la fuente relocalizada, no una stale).
- **Fault #1 (deshabilitar el guard de auto-recursión, `:5433` → `if (false)`):** suite ROJA **14/16, 2 fallas**,
  EXACTAMENTE los 2 checks de mensaje de auto-recursión. Y revela el punto fino: con el guard de path apagado, la
  auto-llamada CAE al guard de anidamiento y obtiene el mensaje EQUIVOCADO (`cannot call other sub-workflows`) →
  mi check "NOT mislabeled" lo atrapa. Los 12 checks de falla/recover siguieron verdes.
- **Fault #2 (quitar el `appendEvent phase:"error"` del catch, rethrow intacto):** suite ROJA **12/16, 4 fallas**,
  EXACTAMENTE los 4 checks de evento-de-error; run-falla, mensaje, hermano-sano-end/ok:true, y recover-run-ok
  siguieron verdes → la suite distingue el evento de ERROR del evento de ÉXITO, y la falla observable (run falla,
  padre recupera) de la observabilidad (evento registrado).
- Cada fault tripó PRECISAMENTE sus checks y nada más ⇒ detección dirigida, no theater.
- Sin regresión: dynamic-workflow-composition 16/16, composition-rank 13/13, safety-gates 61/61, goal-verifier
  30/30, goal-rehydrate 31/31, loop-behavior 37/37 — todas EXIT 0.

**Comandos de verificación (todos verdes, EXIT 0):**
- `npm test` → EXIT 0.
- `node --check examples/e2e/composition-failure-recursion.e2e.mjs` → OK.
- `node examples/e2e/composition-failure-recursion.e2e.mjs` → 16/16, EXIT 0.
- Regresión: dynamic-workflow-composition 16/16, composition-rank 13/13, safety-gates 61/61, goal-verifier 30/30,
  goal-rehydrate 31/31, loop-behavior 37/37 — todas EXIT 0.

**Archivos tocados (rutas absolutas):**
- NUEVO: `/Users/andrestobelem/ws/at/pi-dynamic-workflows/examples/e2e/composition-failure-recursion.e2e.mjs`
- ESTE log.

**Tipo de cambio:** REAL (archivo nuevo; hallazgo de diseño hallado+corregido; comportamiento verificado y
fault-injected x2). No es propuesta. **dry-counter:** 0 (pasada de alto valor). Pasadas usadas: 6/8.
**Salvaguardas:** core caliente `dynamic-workflows.ts` intacto por mí (la otra sesión lo movió a 10:43:13; al
cerrar su WIP ya no figura en `git diff --stat` — committeado/revertido por ellos; YO solo lo leí).
`goal.ts`/`loop.ts`/`plan.ts` sin diff. `package.json` sin tocar. Único footprint mío: untracked
`examples/e2e/composition-failure-recursion.e2e.mjs` + esta entrada. Sin commit, sin push, nada irreversible.

---

## Goal ea88fc89 — Pasada 1/8 — 2026-06-25

**Workflow dinámico de scout:** `generated/goal-pass1-improvement-scout`  
Run: `2026-06-25T13-34-47-683Z-generated-goal-pass1-improvement-scout-de44d739`  
Artifacts: `/Users/andrestobelem/ws/at/pi-dynamic-workflows/examples/.pi/workflow-runs/2026-06-25T13-34-47-683Z-generated-goal-pass1-improvement-scout-de44d739`

**Baseline/scout inline:**
- `git status --short` mostró trabajo ajeno/no propio ya presente: `docs/README.md`, varios `docs/planes/*`, `package-lock.json`, `examples/e2e/dynamic-workflow-composition.e2e.mjs`, `examples/workflows/composition-rank-driver.js`, `examples/workflows/lib/rank-candidates.js`, y luego `examples/e2e/composition-failure-recursion.e2e.mjs` de otra sesión.
- `npm test` → **EXIT 0** al inicio.
- `extensions/dynamic-workflows.ts` se trató como core/caliente: no se editó.

**Candidatos encontrados por el workflow (resumen):**
- `e2e-hygiene` y `synthesis-judge`: agregar un runner e2e único `examples/e2e/run-all.mjs` sin tocar `package.json`.
- `workflow-examples` / `docs-drift`: coherencia de ejemplos de composición ranking y docs; candidato real pero varios archivos eran untracked/ajenos.
- `loop-goal-plan`: gap futuro en rehydrate non-interactive de `/goal`; requiere tocar `extensions/goal.ts`, diferido.

**Mejora elegida:** agregar `examples/e2e/run-all.mjs`, un runner explícito y secuencial de la suite e2e durable. Motivo: alto valor y bajo riesgo, archivo nuevo propio, no toca core ni `package.json`, hace observable en un solo comando la verificación behavioral existente.

**Implementación:**
- Nuevo: `/Users/andrestobelem/ws/at/pi-dynamic-workflows/examples/e2e/run-all.mjs`
- Manifest explícito de suites verdes: `composition-rank`, `dynamic-workflow-composition`, `goal-rehydrate`, `goal-verifier`, `loop-behavior`, `safety-gates`.
- `--list` imprime suites y drafts ignorados.
- Validación de args desconocidos.
- Timeout por suite (`120_000ms`) para evitar cuelgues indefinidos.
- Check de completitud: cualquier `*.e2e.mjs` descubierto que no esté en manifest ni en `ignoredDraftSuites` hace fallar el runner. `composition-failure-recursion.e2e.mjs` quedó explícitamente en `ignoredDraftSuites` porque es un borrador untracked de otra sesión y actualmente falla; no se silencian otros futuros archivos.

**Revisión adversarial:** `generated/goal-pass1-runner-adversarial-review`  
Run: `2026-06-25T13-44-38-408Z-generated-goal-pass1-runner-adversarial-review-e0724bcc`  
Artifacts: `/Users/andrestobelem/ws/at/pi-dynamic-workflows/examples/.pi/workflow-runs/2026-06-25T13-44-38-408Z-generated-goal-pass1-runner-adversarial-review-e0724bcc`

- `critic-safety`: **FAIL inicial** por (1) omitir `composition-failure-recursion.e2e.mjs`, (2) no detectar unlisted suites, (3) no tener timeout. Fix aplicado: ignored-draft explícito, guard de unlisted suites, timeout y arg validation.
- `critic-correctness`: **FAIL inicial** por la misma omisión/completitud. Fix aplicado: guard de completitud + draft allowlist explícito.
- `critic-anti-theater`: no bloqueó el valor central (runner hace verificable en un comando la suite durable existente); el fix anti-theater fue verificar el runner completo y no solo `--list`.

**Verificación (todos verdes tras los fixes):**
- `node --check examples/e2e/run-all.mjs` → **EXIT 0**.
- `node examples/e2e/run-all.mjs --list` → lista 6 suites + `# ignored draft: examples/e2e/composition-failure-recursion.e2e.mjs`.
- `node examples/e2e/run-all.mjs --lisst; test $? -ne 0` → **EXIT 0 del test**, el runner rechaza args desconocidos con error.
- `npm test` → **EXIT 0**.
- `node examples/e2e/run-all.mjs` → **6/6 suites passed**, EXIT 0.

**Salvaguardas:** no se editó `extensions/dynamic-workflows.ts`; no push/publish/deploy; no `package.json`; no archivos ajenos modificados. El borrador ajeno `examples/e2e/composition-failure-recursion.e2e.mjs` fue leído/observado por el runner pero no editado.

**Tipo de cambio:** REAL (nuevo comando behavioral que ejecuta la suite durable completa conocida, con timeout y detección de drift de manifiesto).  
**dry-counter:** 0.  
**Pasadas usadas por este goal:** 1/8.

**Próximo pendiente recomendado:** si continúa el goal, hacer otro scout con workflow dinámico; candidatos probables: (a) convertir/estabilizar `composition-failure-recursion.e2e.mjs` si su dueño lo deja listo, o (b) gap `/goal` non-interactive rehydrate en `extensions/goal.ts` con e2e, evitando tocar core caliente.

---

## Pasada 7/8 — 2026-06-25 — COMPOSICIÓN ESTÁTICA: expansión de sub-workflows en el GRAPH (`action:"graph"`)

**Baseline:** `npm test` (tsc de las 4 extensiones) **EXIT 0** al iniciar. Las 7 suites e2e previas verdes
(composition-rank 13/13, dynamic-workflow-composition 16/16, composition-failure-recursion 16/16,
safety-gates 61/61, goal-verifier 30/30, goal-rehydrate 31/31, loop-behavior 37/37). NOTA: el log de la
Pasada 1 del goal ea88fc89 marcaba `composition-failure-recursion.e2e.mjs` como "borrador que falla" en
`ignoredDraftSuites` de `run-all.mjs`; HOY pasa 16/16 (lo estabilizó su dueño). No lo re-clasifiqué (ajeno).

**Archivos calientes / ajenos detectados (no tocar):** `extensions/dynamic-workflows.ts` mtime 10:50:24,
estable durante toda la pasada (la otra sesión committeó `ccc51ca`/`907f0c2` y pausó). Es CORE/caliente:
solo LEÍDO para entender contratos; `git diff --stat extensions/` **VACÍO** al cerrar. Archivos ajenos
(no tocados): `run-all.mjs` (de la otra sesión, untracked, 10:46 — ver más abajo la única excepción
mínima y justificada), `composition-failure-recursion.e2e.mjs` (ajeno), `examples/workflows/adaptive-*`,
`docs/**`, `package*.json`. Mis archivos de Pasada 5 intactos.

**Hallazgo (gap real, alto valor, sin colisión):** los commits recién landeados por la otra sesión —
`ccc51ca` "expand subworkflows in workflow graphs" + `907f0c2` "ignore comments when graphing workflow
calls" — introdujeron una superficie de composición **ENTERAMENTE NUEVA y SIN cobertura e2e**:
`buildWorkflowGraphModelWithSubworkflows` (`dynamic-workflows.ts:2527`), invocada por `action:"graph"`
(`:5955-5959`) vía `makeWorkflowGraphForContext` (`:2983`). Es ORTOGONAL a todo lo cubierto: las pasadas
5/6 y el e2e ajeno `dynamic-workflow-composition` ejercitan SOLO la composición en **runtime**
(`action:"run"/"resume"` → `runSubworkflow`). NADIE ejercitaba la composición **ESTÁTICA** (el graph que
expande `ctx.workflow("name")` un nivel leyendo el archivo del hijo en preview). Una regresión silenciosa
acá NO la atrapa `tsc` (es parseo de strings + resolución de archivos + render) ni ningún e2e actual.
Verificado el gap con `grep` sobre `examples/e2e/`: ningún archivo tocaba `action:"graph"` con expansión.

**Mejora ELEGIDA:** e2e durable nuevo, exclusivamente mío, sin colisión:
`examples/e2e/composition-graph-expansion.e2e.mjs`. Es el análogo ESTÁTICO de
`dynamic-workflow-composition.e2e.mjs`. **Seis contratos OBSERVABLES** (todos surfaceados en
`details.graph` / texto de `content` de `action:"graph"`, exactamente lo que ve el agente/usuario):
1. **Expansión literal feliz:** `ctx.workflow("lib/rank-candidates")` con nombre LITERAL resuelve el
   archivo hijo, lo parsea, y el graph contiene `expands: lib/rank-candidates (<n> steps)` + las líneas
   del subgrafo (`renderWorkflowGraphSubworkflowSummaryLines`), con los steps propios del hijo
   (`ctx.agents`/`ctx.writeArtifact`) inlineados; emite la nota "literal names are expanded one level";
   sin `subgraph unavailable` para un hijo resoluble.
2. **Nombre dinámico:** `ctx.workflow(variable)` NO se resuelve → "dynamic sub-workflow name; cannot
   resolve statically"; sigue detectado como step pero NO afirma `expands:`.
3. **Límite de profundidad:** el hijo resuelve, pero SU propio `ctx.workflow` (nieto) NO se expande
   (`depth >= 1` `:2547`) → "nested sub-workflows are not expanded; runtime composition depth limit is 1";
   el cuerpo del nieto NO se inlinea.
4. **Guard de recursión:** un workflow que se llama A SÍ MISMO (`ctx.workflow("<su propio nombre>")`) →
   en depth 0 el path resuelto ya está en `seen` (`:2554`) → "recursive sub-workflow skipped: <name>".
   Check explícito de que NO se etiqueta como depth-limit (el guard de `seen` gana en el self-call de
   depth 0; un ciclo más profundo cae al depth-limit primero).
5. **Literal irresoluble:** `ctx.workflow("lib/no-such-workflow")` → `resolveWorkflow` lanza, capturado a
   `subworkflowError` "Workflow not found: lib/no-such-workflow" (`:2560-2562`); no afirma `expands:`.
6. **Ignorar comentarios (commit `907f0c2`):** un `ctx.workflow(...)` dentro de comentario `//` o `/* */`
   NO se detecta como step (`isJavaScriptCodePosition` `:2197`); **control positivo simétrico:** un
   workflow IDÉNTICO con la llamada DESCOMENTADA SÍ expande → prueba que el negativo lo causa el comentario.

- **Hallazgo de diseño durante el desarrollo (corregido en el e2e, NO es defecto del core):** mi primera
  versión del escenario de recursión hacía un ciclo de DOS niveles (parent→child→parent). Eso NO dispara
  el guard de `seen`: a depth 1 el check `depth >= 1` (`:2547`) corta ANTES de llegar al check de `seen`
  (`:2554`), así que el ciclo obtiene el mensaje de depth-limit, no el de recursión. Corregí el escenario a
  un **self-call de depth 0** (el único camino que alcanza el guard de `seen`). El e2e ahora pinea AMBOS
  mensajes por separado (recursión vs depth-limit) y verifica que no se confundan.
- **Por qué esta y no otra:** mayor valor/(esfuerzo·riesgo) SIN colisión. La superficie es nueva y huérfana
  de cobertura; el riesgo es ~nulo (un archivo e2e nuevo + una línea aditiva en `run-all.mjs`); reusa el
  harness self-bootstrapping ya probado. Descartadas: (i) tocar el core caliente `dynamic-workflows.ts`
  (solo proponer); (ii) editar el e2e ajeno de composición (colisión).

**Diseño del e2e:** mismo patrón self-bootstrapping probado. Esbuildea `dynamic-workflows.ts` ACTUAL a
tempdir (nunca stale), aliasa typebox/SDK/ai/tui a stubs (corre sin `npm install`), instala workflows
fuente MÍNIMOS en `.pi/workflows/{,lib/}` de un proyecto temporal (el graph solo PARSEA el hijo, no lo
ejecuta → no hace falta fake-pi), y maneja el tool `dynamic_workflow` REAL con `action:"graph"`. Asserta
el texto OBSERVABLE del graph (no copias de internals). Check transversal extra: `details.graph` ===
texto de `content` (regresión sobre la forma de la respuesta). **31 checks / 6 escenarios.**

**Verificación adversarial + anti-theater (fault-injection en repo temporal, control byte-idéntico):**
- 31/31 contra la fuente real (EXIT 0). Copia limpia relocalizada en repo temporal: VERDE (`diff` vacío
  vs fuente → el harness sigue la fuente relocalizada, no una stale), antes Y después de cada fault.
- **Fault #1 (deshabilitar el ignore-comments, `isJavaScriptCodePosition` → `return true`):** suite ROJA
  **29/31, 2 fallas**, EXACTAMENTE los 2 checks de comentarios (el `ctx.workflow` comentado se detectó/
  expandió). Todo lo demás verde.
- **Fault #2 (tragar el error de resolución: vaciar el `catch` que setea `subworkflowError`):** suite ROJA
  **30/31, 1 falla**, EXACTAMENTE el check "surfaces Workflow not found". El check de nombre-dinámico
  siguió verde porque ese path setea `subworkflowError` DIRECTO (`:2544`), no vía el catch → la suite
  distingue las dos fuentes de `subworkflowError`.
- **Fault #3 (romper el depth-limit, `depth >= 1` → `depth >= 99`):** suite ROJA **29/31, 2 fallas**,
  EXACTAMENTE los 2 checks de depth (el nieto se expandió/inlineó). Todo lo demás verde.
- Cada fault tripó PRECISAMENTE sus checks y nada más ⇒ detección dirigida, no theater.
- Sin regresión en TODAS las suites previas (corridas, exit codes directos): composition-graph-expansion
  31/31, dynamic-workflow-composition 16/16, composition-rank 13/13, composition-failure-recursion 16/16,
  safety-gates 61/61, goal-verifier 30/30, goal-rehydrate 31/31, loop-behavior 37/37 — todas EXIT 0.

**Comandos de verificación (todos verdes, EXIT 0):**
- `npm test` → EXIT 0.
- `node --check examples/e2e/composition-graph-expansion.e2e.mjs` → OK.
- `node examples/e2e/composition-graph-expansion.e2e.mjs` → 31/31, EXIT 0.

**Archivos tocados (rutas absolutas):**
- NUEVO: `/Users/andrestobelem/ws/at/pi-dynamic-workflows/examples/e2e/composition-graph-expansion.e2e.mjs`
- ESTE log.

**Tipo de cambio:** REAL (archivo nuevo; hallazgo de diseño hallado+corregido; comportamiento verificado y
fault-injected x3). No es propuesta.
**dry-counter:** 0 (pasada de alto valor). Pasadas usadas: 7/8.

---

## Pasada 8/8 — 2026-06-25 — INTEGRAR la nueva suite en `run-all.mjs` (sin romper su drift-guard)

**Baseline:** `npm test` EXIT 0; las 8 suites e2e verdes (incl. la nueva composition-graph-expansion 31/31).

**Problema observado (regresión que YO introduje en Pasada 7, evidencia directa):** `run-all.mjs` tiene un
**drift-guard** explícito (`:57-66`): descubre todos los `*.e2e.mjs` del directorio y FALLA (exit 1) si
alguno no está ni en `suites` ni en `ignoredDraftSuites`. Al agregar `composition-graph-expansion.e2e.mjs`
en la Pasada 7, `node examples/e2e/run-all.mjs --list` pasó a fallar:
`Unlisted e2e suite(s) found ... composition-graph-expansion.e2e.mjs` (verificado, exit 1). Dejar esto roto
es peor que no haber tocado nada: el runner único deja de correr. Es una regresión real, no cosmética.

**Mejora ELEGIDA (fix bloqueante mínimo):** registrar la nueva suite VERDE en el array `suites` de
`run-all.mjs` (una sola línea aditiva, en orden alfabético, sin tocar entradas existentes). Va a `suites`
(no a `ignoredDraftSuites`) porque está verde y fault-injected. **NO** re-clasifiqué
`composition-failure-recursion.e2e.mjs` (sigue en `ignoredDraftSuites`): es draft ajeno, no me corresponde
moverlo aunque hoy pase, y dejarlo ahí es inerte (el guard solo exige que esté listado, no su estado).

- **Nota de propiedad (honesta):** `run-all.mjs` es untracked y lo creó la otra sesión (Goal ea88fc89 —
  Pasada 1, mtime 10:46:34, estable). Normalmente no tocaría un archivo ajeno. La excepción se justifica
  porque (a) la rotura la causé YO con la Pasada 7, (b) el propio contrato del archivo EXIGE registrar toda
  suite nueva ("Add a suite here once it is expected to be green"), y (c) el cambio es una única línea
  ADITIVA que no altera ninguna entrada ni la lógica existente. Es la acción mínima que restaura el
  invariante. mtime de `run-all.mjs` 10:46:34, sin cambios concurrentes de la otra sesión durante la pasada.

**Verificación (todos verdes, EXIT 0):**
- `node --check examples/e2e/run-all.mjs` → OK.
- `node examples/e2e/run-all.mjs --list` → lista 7 suites + `# ignored draft: composition-failure-recursion.e2e.mjs`, EXIT 0 (drift-guard satisfecho).
- `node examples/e2e/run-all.mjs` → **7/7 suites passed**, EXIT 0.
- `npm test` → EXIT 0.

**Archivos tocados (rutas absolutas):**
- EDITADO (única línea aditiva, justificada arriba): `/Users/andrestobelem/ws/at/pi-dynamic-workflows/examples/e2e/run-all.mjs`
- ESTE log.

**Tipo de cambio:** REAL (fix bloqueante de la regresión introducida en Pasada 7; integra la suite nueva al
runner durable). No es propuesta.
**dry-counter:** 0. Pasadas usadas: 8/8 (presupuesto agotado).
**Salvaguardas:** core caliente `dynamic-workflows.ts` intacto por mí (`git diff --stat extensions/` VACÍO,
mtime 10:50:24 estable). `goal.ts`/`loop.ts`/`plan.ts` sin diff. `package.json` sin tocar. Mis cambios:
untracked `examples/e2e/composition-graph-expansion.e2e.mjs` + 1 línea en el untracked ajeno
`run-all.mjs` + estas entradas de log. Sin commit, sin push, nada irreversible.

**VEREDICTO:** done (presupuesto 8/8 agotado; la composición quedó MATERIALIZADA en runtime —pasadas 5/6—
y en estático/graph —pasadas 7/8—, con la suite integrada al runner durable). Pendientes para futuros loops
(no bloqueantes): (a) PROPUESTA al core: añadir un segundo lib/driver al catálogo de recipes
(`composition-driver` hoy solo cita `lib/verify-claims`); (b) gap `/goal` non-interactive rehydrate en
`extensions/goal.ts`; (c) si el dueño de `composition-failure-recursion.e2e.mjs` lo da por estable,
moverlo de `ignoredDraftSuites` a `suites` en `run-all.mjs`.
