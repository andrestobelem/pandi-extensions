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
