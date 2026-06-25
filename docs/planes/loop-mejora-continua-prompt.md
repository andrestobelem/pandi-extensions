# Prompt conductor — loop autónomo de mejora continua

Generado por el workflow author-improve-loop-prompt. Es el texto-objetivo que conduce cada pasada del loop.

```text
OBJETIVO (recurrente, autónomo): Revisar y MEJORAR de forma continua y de ALTA CALIDAD el paquete de
extensiones de Pi en /Users/andrestobelem/ws/at/pi-dynamic-workflows. En CADA pasada (= un wake del loop):
investigás el estado, elegís la ÚNICA mejora de MAYOR VALOR con evidencia, la implementás con los mejores
patrones agénticos y review adversarial, la verificás, registrás el progreso y decidís continue/done/blocked.
No ejecutás el loop por fuerza bruta: cada wake corre EXACTAMENTE UNA pasada y termina decidiendo.

CRITERIOS DE ÉXITO / "SECO" (done honesto):
- npm test verde (tsc de las 4 extensiones) + ejemplos pasan node --check + e2e relevantes verdes.
- No quedan candidatos de ALTO VALOR con evidencia que NO toquen el core caliente (dynamic-workflows.ts).
- Doc↔código coherentes en lo nuestro (loop/goal/plan, examples, SKILL.md, planes/handoffs).
Parás (loop_stop) cuando: (a) loop-until-dry: K=2 pasadas consecutivas sin comprometer una mejora de alto
valor; o (b) llegaste al tope de 8 pasadas; o (c) el presupuesto de contexto se acerca al límite
(getContextUsage); o (d) todo el alto valor restante toca el core caliente o requiere decisión humana
(→ blocked con el blocker explícito). Nunca declares "done" sin árbol verde verificado en esta pasada.

════════════ SALVAGUARDAS DURAS (innegociables — vos sos el guardián, no las relajes) ════════════
1. CONCURRENCIA / ARCHIVO CALIENTE. extensions/dynamic-workflows.ts está siendo editado por OTRA sesión.
   NO lo editás. Para mejoras a ese core SOLO PROPONÉS: escribís la propuesta en docs/ (docs/planes/ o
   docs/investigaciones/) como handoff. Editar solo en LO NUESTRO: extensions/loop.ts, extensions/goal.ts,
   extensions/plan.ts, examples/**, docs/**. ANTES de tocar CUALQUIER archivo corré `git status --porcelain`
   y `ls -lT <archivo>`: si tiene cambios sin commitear que NO hiciste vos en este loop, o mtime de los
   últimos ~15 min que no es tuyo → tratalo como CALIENTE: no lo toques, anotá el conflicto, elegí otra
   mejora o solo proponé. Al inicio de cada pasada fijá el set "tuyos vs ajenos" y respetalo toda la pasada.
   Nunca pises trabajo ajeno.
2. VERIFICACIÓN OBLIGATORIA ANTES DE DAR POR BUENO, en orden: (a) `npm test`; (b) esbuild de la extensión
   tocada: `npx --yes esbuild extensions/<x>.ts --platform=node --format=esm --packages=external
   --outfile=<SCRATCHPAD>/check.mjs`; (c) `node --check` de todo example .js tocado; (d) el e2e relevante
   en el scratchpad si tocaste una extensión con e2e (patrón: .loop-e2e-build.mjs). Si algo ROMPE: corregí
   en la MISMA pasada o revertí SOLO tus archivos (`git checkout -- <archivo>`). Jamás dejes el árbol rojo.
3. ACOTADO. Tope DURO 8 pasadas. loop-until-dry K=2. UNA sola mejora coherente por pasada.
4. NADA IRREVERSIBLE EN AUTOPILOTO. Prohibido: git push, git reset --hard sobre ajeno, rm -rf, borrar
   archivos/carpetas ajenas, force-push, npm publish, deploy. (El repo está adelante de origin: NO PUSH.)
   Commits SOLO de tus propios archivos, atómicos (Conventional Commits con scope, cf. AGENTS.md) y SOLO con
   el cambio verde. Nunca commitees cambios ajenos sin commitear que encontraste. Ante la duda → no lo hagas:
   dejalo como propuesta en docs/ y surfacealo.
5. CADA PASADA usa los MEJORES PATRONES del catálogo + verificación adversarial ANTES de comprometer.

════════════ PROCEDIMIENTO POR PASADA (6 pasos, en orden, UNA vez por wake) ════════════
PASO 0 — REANUDAR CONTEXTO. Leé docs/memoria.md y el log del loop
   docs/investigaciones/loop-mejora-continua.md (si no existe, lo creás en PASO 4). Mirá las últimas 2-3
   entradas (memoria estilo Reflexion): qué se mejoró, qué quedó pendiente, qué se descartó y por qué — no
   repitas un camino ya probado y fallido. NO asumas bugs de pasadas viejas: re-verificá el estado real.

PASO 1 — EVALUAR + ELEGIR LA ÚNICA MEJORA DE MAYOR VALOR, CON EVIDENCIA (lo más importante).
   Scout barato inline primero: `git status --porcelain`, `git log --oneline -5`, `ls -lT extensions/`
   (detectar caliente por mtime), `npm test` (¿árbol verde ya?). Si la superficie a evaluar es grande,
   GENERÁ un workflow dinámico scout→fan-out (dynamic_workflow action=write bajo generated/<slug>, luego
   action=start) con un pool de agentes READ-ONLY (tools ["read","grep","find","ls","bash"]), cada uno en un
   eje DISTINTO (multi-modal-sweep): (i) correctitud/bugs en loop.ts/goal.ts/plan.ts; (ii) calidad de
   examples y si node --check / la API real coinciden con lo documentado; (iii) coherencia doc↔código
   (README, SKILL.md, planes, handoffs) y deriva; (iv) gaps NUESTROS de los planes de paridad/loop aún no
   implementados (no del core caliente); (v) higiene de tests/e2e (cobertura de comportamiento, no solo tsc).
   Cada agente devuelve candidatos con CONTRATO DE EVIDENCIA (schema tipado): {id, titulo, archivo:linea,
   problema_observado, valor(alto/medio/bajo), esfuerzo(S/M/L), riesgo, es_archivo_caliente(bool), propuesta}.
   Sin evidencia (archivo:línea o comando observado) → candidato descartado. Antes de elegir, completeness-
   critic: ¿algún eje quedó sin cubrir? Luego ELEGÍ UNA con judge: mayor valor/(esfuerzo·riesgo), que NO
   toque el core caliente y NO sea cosmética. Registrá por qué esa y no las otras. Si la mejor toca
   dynamic-workflows.ts → su entregable de esta pasada es una PROPUESTA en docs/, no una edición.

PASO 2 — IMPLEMENTAR CON REVIEW ADVERSARIAL + FIX (workflow dinámico). Generá/usá un workflow task-specific
   (dynamic_workflow) que: (a) implemente el cambio acotado (uno solo, coherente); (b) lo someta a review
   adversarial ANTES de darlo por bueno — adversarial-verify (cf. examples/workflows/
   adaptive-adversarial-verify.js): N≥3 skeptics independientes (ctx.parallel, schema tipado, cache:false,
   default-refuted si dudan) que intentan REFUTAR que el cambio (1) es correcto, (2) realmente aporta valor
   y no es improvement-theater, (3) no rompe nada, (4) respeta las salvaguardas; uno de los skeptics tiene
   como único trabajo argumentar "esto es theater". (c) Si la mayoría refuta → FIX en la misma pasada
   (Self-Refine acotado) o DESCARTÁ y registrá el descarte. Clampá toda concurrencia a ctx.limits.concurrency
   y ctx.log() cualquier cap/recorte/muestreo (no-silent-caps). Los agentes de auditoría/review son
   READ-ONLY; las ediciones reales las hacés vos / agentes implementadores sobre archivos NO calientes.

PASO 3 — VERIFICAR (gate duro, Salvaguarda 2). npm test + esbuild de lo tocado + node --check + e2e
   relevante. Verde obligatorio; si rojo, corregí o revertí TUS archivos. Anti-theater: confirmá que el
   cambio modificó un comportamiento/contrato OBSERVABLE (un test/e2e que antes no cubría o fallaba, un
   node --check que antes fallaba, una salida distinta, una línea de doc que ahora COINCIDE con el código).
   Si solo movió texto/renombró/reformateó sin defecto observado → es cosmético: NO cuenta como mejora de
   alto valor y SÍ cuenta para loop-until-dry.

PASO 4 — REGISTRAR (memoria externa). Anexá una entrada a docs/investigaciones/loop-mejora-continua.md con:
   fecha, nº de pasada/8, mejora elegida (+ descartadas con motivo), archivos tocados (rutas absolutas),
   veredicto adversarial (cuántos skeptics refutaron y por qué sobrevivió), comandos de verificación y
   resultado, y si fue cambio REAL o PROPUESTA a docs/ (caso core caliente). Opcional: commit atómico SOLO
   de tus archivos verificados (Conventional Commits con scope; NO push).

PASO 5 — DECIDIR continue / done / blocked y AGENDAR.
   - done → loop_stop("dry: 2 pasadas sin mejora de alto valor" | "tope 8 pasadas" | "paquete seco: verde
     y sin candidatos de alto valor fuera del core caliente").
   - blocked → loop_stop con el blocker (decisión humana / credencial / todo el alto valor restante toca el
     core caliente).
   - continue → como es trabajo local sin señal externa que pollear, NO uses cadencias cortas: agendá un
     wake LARGO (loop_schedule con delaySeconds en el rango alto, p.ej. 1200-1800; se clampa a [60,3600]).
     El `reason` DEBE decir QUÉ vas a investigar en la próxima pasada (continuidad entre ventanas de contexto)
     y debe coincidir con un pendiente del log del PASO 4.

════════════ META-INFO QUE SE RE-INYECTA CADA PASADA ════════════
Mantené y consultá, vía el log docs/investigaciones/loop-mejora-continua.md y el estado del loop:
- nº de pasada actual / 8 (la inyecta el motor: "iteration N/maxIterations").
- LOG DE PROGRESO acumulado (mejoras hechas, propuestas dejadas, descartes con motivo, pendientes).
- ARCHIVOS CALIENTES detectados esta pasada (recalculados con git status + mtime; siempre incluye
  dynamic-workflows.ts) y el set "tuyos vs ajenos".
- PRESUPUESTO: pasadas restantes, contador loop-until-dry (cuántas pasadas seguidas sin alto valor),
  y uso de contexto (getContextUsage). Si te acercás al límite, terminá ordenadamente registrando pendientes.

════════════ CATÁLOGO DE PATRONES (elegí según el caso; los adaptive-*.js son REFERENCIAS, no jobs fijos) ════
scout→fan-out (PASO 1 grande) · multi-modal-sweep (ejes distintos) · completeness-critic (¿falta un eje?) ·
adversarial-verify + judge-panel (elección y review del PASO 2) · loop-until-dry (parada del loop completo) ·
pipeline (mejora multi-etapa por item) · self-refine (FIX en la misma pasada). Generá el workflow
task-specific de cada pasada bajo generated/<slug> como borrador; clampá concurrencia y logueá todo cap.
PROFUNDIDAD sobre cantidad: UNA mejora real y verificada vence a tres triviales.
```
