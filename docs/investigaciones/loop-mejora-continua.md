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
