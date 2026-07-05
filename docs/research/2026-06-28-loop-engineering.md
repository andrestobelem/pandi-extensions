---
type: "Research Note"
title: "Loop engineering — una investigación respaldada por fuentes"
description: "Investigación sobre bucles agente observación verificación y condiciones de parada basadas en evidencia."
tags: [loop-engineering, agents, verification, control]
timestamp: 2026-06-28T00:00:00Z
---

# Loop engineering — una investigación respaldada por fuentes

Fecha: 2026-06-28

**Proveniencia de registro.** Generado por el workflow dinámico `loop-engineering-deep-research` (run `2026-06-28T10-08-08-680Z-drafts-loop-engineering-deep-research-ebc0fa72`), enrutado por un Contract Gate de solo lectura (interpretación C) y confirmado por un verificador independiente de citación/trazabilidad de solo lectura (veredicto PASS). No se modificó código fuente. La evidencia por rama y el informe del verificador viven en ese directorio de run dentro de `.pi/workflows/runs/`.

## En 30 segundos

Este documento explica qué significa *loop engineering* y cómo ese patrón aparece en este repo. La idea central es simple: diseñar bucles que **actúan → observan → verifican → continúan** hasta cumplir una condición de parada basada en evidencia.

La conclusión práctica es más importante que el nombre: un loop confiable necesita límites explícitos, una señal de crítica independiente y una salida que no dependa de la autodeclaración del modelo.

> **Nota de proveniencia y honestidad.** El encabezado de la tarea reportó "Branches: 5 / Completed: 5 / Failed: 0", pero los payloads reales muestran que **solo 2 de 5 ramas devolvieron contenido**: `research-reflexion-self-refine` y `research-control-feedback-theory`. Tres ramas devolvieron **salida vacía**: `research-react-observe-act`, `research-bounding-failure-modes-term`, `research-repo-grounding`.
>
> Para no inventar cobertura, el sintetizador **volvió a leer de forma independiente cada archivo del repo en la grounding read-list** (todos los `file:line` de abajo fueron verificados en este run) y **ejecutó su propia búsqueda web** para resolver la pregunta sobre el término. Las URLs externas de teoría de control se **preservaron desde la rama 3** y no se volvieron a buscar en la síntesis (marcado en §8). Los papers externos sobre loops de agentes citados por la rama 2 (Reflexion, Self-Refine, Huang et al.) fueron recuperados por esa rama; ReAct no fue recuperado de forma independiente por ninguna rama (marcado INSUFFICIENT_EVIDENCE).

**Actualización — pase de verificación de fuentes (2026-06-28).** Un seguimiento puntual cerró los principales ítems `INSUFFICIENT_EVIDENCE` mediante búsqueda web directa: ReAct (arXiv:2210.03629) ahora está confirmado por fuente primaria (Yao et al., ICLR 2023); los contraargumentos del debate sobre autocorrección (arXiv:2405.14092 *ProCo*; arXiv:2406.15673) se leyeron en vez de citarse solo por título; el límite experimental de Self-Refine es **4 iteraciones**; y el repo citado por el paper de Reflexion `github.com/noahshinn024/reflexion` ahora aloja un proyecto **no relacionado** "Bugbounty POC" (el código original ya no está en esa URL). Las entradas de §3 y §8 reflejan este pase.

## 1. Resumen ejecutivo

**"Loop engineering" es un término industrial real y reciente (mitad de 2026), no una disciplina académica ya estabilizada.** Nombra un patrón más viejo: diseñar el sistema que le pide repetidamente a un agente que *actúe → observe → verifique → continúe* hasta que se dispare una condición de parada basada en evidencia. Fuentes clave: [Addy Osmani](https://addyosmani.com/blog/loop-engineering/), [LangChain](https://www.langchain.com/blog/the-art-of-loop-engineering), [Claude Code docs](https://code.claude.com/docs/en/how-claude-code-works) y [The Register, 2026-06-24](https://www.theregister.com/ai-and-ml/2026/06/24/loop-engineering-latest-ai-buzzword-still-needs-humans-in-the-loop/5261735) (cobertura escéptica).

La literatura converge en una lección dura: **un loop iterativo de mejora propia solo es tan confiable como (a) la independencia/calidad de su señal de crítica y (b) sus límites.**

La autocorrección puramente intrínseca puede *degradar* los resultados cuando no existe una señal externa/oráculo ([Huang et al., arXiv:2310.01798](https://arxiv.org/abs/2310.01798)). Tanto Reflexion como Self-Refine incluyen límites explícitos de terminación ([arXiv:2303.11366](https://arxiv.org/abs/2303.11366); [arXiv:2303.17651](https://arxiv.org/abs/2303.17651)).

**Este repo operacionaliza bien esa lección.** A través de tres superficies de loop implementa de forma consistente terminación acotada, clamping de “no confiar en el modelo”, caps explícitos (no silenciosos) y — lo más importante — un *verificador adversarial independiente y de solo lectura* que no acepta cerrar un goal por la autodeclaración del modelo (`extensions/pandi-goal/index.ts:36-51`, `:362-386`). La mejor decisión de diseño es la separación de pandi-goal entre auto-chequeo (`verifying`) y juicio independiente (`verifying-independent`), una respuesta arquitectónica directa a Huang et al.

**Los principales gaps son limitaciones, no defectos:**

- El cap de presupuesto de contexto es best-effort y hace no-op en silencio si el uso es desconocido (`extensions/pandi-loop/caps.ts:36-40`).
- "Quiet rounds" es una heurística empírica de convergencia, no un criterio probado de punto fijo.
- La afirmación de la read-list de que el clamp de cadencia dinámica vive en `extensions/pandi-loop/interval.ts` es **incorrecta** — vive en `extensions/pandi-loop/index.ts:1253-1259`.

## 2. Qué significa "loop engineering" (¿es ya un término establecido?)

**Veredicto: establecido como término industrial emergente (CONFIRMADO por búsqueda web en este run), pero no como disciplina académica estandarizada.** Definilo en la primera mención.

Evidencia encontrada:

- **Addy Osmani** enmarca *loop engineering* como *diseñar el sistema que le pide a un agente* — automatización, worktrees, skills, connectors, subagents y estado externo. [addyosmani.com/blog/loop-engineering](https://addyosmani.com/blog/loop-engineering/)
- **LangChain** ("The Art of Loop Engineering") enmarca a los agentes como loops de tool-calling, extendidos a loops de verificación y loops event-driven. [langchain.com/blog/the-art-of-loop-engineering](https://www.langchain.com/blog/the-art-of-loop-engineering)
- **Claude Code docs** describen el loop agéntico como *reunir contexto → actuar → verificar resultados → repetir hasta completar*. [code.claude.com/docs/en/how-claude-code-works](https://code.claude.com/docs/en/how-claude-code-works)
- **OpenAI** (agent improvement loop cookbook) señala que el área todavía evoluciona; la idea durable es conectar feedback, testing e implementación en un solo loop. [developers.openai.com/.../agent_improvement_loop](https://developers.openai.com/cookbook/examples/agents_sdk/agent_improvement_loop)
- **The Register (2026-06-24)** lo caracteriza como un *nuevo buzzword de IA* y advierte que la automatización sigue necesitando controles de costo y humanos en el loop. [theregister.com/.../loop_engineering...](https://www.theregister.com/ai-and-ml/2026/06/24/loop-engineering-latest-ai-buzzword-still-needs-humans-in-the-loop/5261735)

**Definición de trabajo sintetizada (este artefacto):** *loop engineering* es la disciplina de **diseñar, acotar y verificar** loops iterativos/de feedback alrededor de sistemas agénticos y de software. Un loop debe hacer progreso medible hacia una meta y **parar en evidencia** (done/quiet/blocked) en vez de hacerlo por reloj, por autodeclaración o nunca. Este es el marco paraguas que el repo ya practica bajo otros nombres: `/loop`, `loop-until-done`, `/goal`.

## 3. Fundamentos y trabajos previos — con citas

| Patrón | Idea central | Fuente primaria | Estado de verificación |
|---|---|---|---|
| **ReAct** | Intercalar trazas de razonamiento con acciones/tool calls (reason → act → observe), habilitando planificación dinámica + uso de herramientas externas. | arXiv:2210.03629 — `https://arxiv.org/abs/2210.03629` · sitio oficial `https://react-lm.github.io/` | **CONFIRMADO (pase de verificación de fuentes, 2026-06-28).** Yao, Zhao, Yu, Du, Shafran, Narasimhan, Cao; v3 = **ICLR 2023** camera-ready. Intercala trazas de razonamiento, acciones y observaciones del entorno; evaluado en HotpotQA, FEVER, ALFWorld y WebShop. |
| **Reflexion** | Loop en tiempo de inferencia: el Actor intenta → el Evaluator puntúa → Self-Reflection escribe lecciones verbales dentro de una **memoria episódica acotada (≈1–3 entradas)** que se antepone al siguiente intento. No hay actualización de pesos. HumanEval pass@1 91.0 vs 80.1 baseline; **no hay garantía formal de convergencia, puede caer en mínimos locales**. | arXiv:2303.11366 — abstract `https://arxiv.org/abs/2303.11366` · PDF `https://arxiv.org/pdf/2303.11366` | Recuperado por la rama 2. |
| **Self-Refine** | Mismo modelo: generar `y0` → crítica **accionable y localizada** → refinar; parar en un **límite fijo de iteraciones** o en una señal de parada específica de la tarea; el historial se conserva. El feedback genérico o ausente rinde peor. | arXiv:2303.17651 — `https://arxiv.org/abs/2303.17651` · `https://selfrefine.info/` · código `https://github.com/madaan/self-refine` | Recuperado por la rama 2. |
| **La autocorrección es poco confiable (contraevidencia)** | La autocorrección intrínseca suele depender de feedback oracular/externo; si se lo quita, los modelos (GPT-3.5/4/4-Turbo, Llama-2) **no mejoran y a veces empeoran**, convirtiendo respuestas correctas en incorrectas. La crítica multironda debería compararse contra self-consistency de costo equivalente. | Huang et al., arXiv:2310.01798 (ICLR 2024) — `https://arxiv.org/abs/2310.01798` | Recuperado por la rama 2; **contraargumentos leídos (2026-06-28).** (i) arXiv:2405.14092 (Wu et al., EMNLP 2024, *ProCo* — "…Key Condition Verification") muestra que la autocorrección intrínseca *estructurada* (ocultar una condición clave → verificar → resolver de nuevo) supera la autocorrección simple (+6.8 EM open-domain QA, +14.1 arithmetic, +9.6 commonsense en GPT-3.5-Turbo-1106); (ii) arXiv:2406.15673 (Liu et al., "LLMs have Intrinsic Self-Correction Ability") rebate 2310.01798 *condicionalmente* — las mejoras se mantienen con **temperature 0 y prompts no sesgados**, mientras que prompts sesgados del tipo "find problems" vuelven correctas algunas respuestas incorrectas (límites: 4 modelos, 2 datasets, sin barras de error). Conclusión: Huang et al. se sostiene para loops intrínsecos *ingenuos/sesgados*; la verificación estructurada o el prompting no sesgado/a baja temperatura pueden recuperar mejoras. |
| **Teoría de control / feedback** | Open-loop aplica un comando sin medir la salida (no puede autocorregir perturbaciones); closed-loop mide la variable de proceso, la compara con un setpoint y actúa sobre el error. Stability = respuesta acotada que decae (pole locations); ganancia excesiva → overshoot/oscillation/instability; damping gobierna el ringing; hysteresis = deadband deliberado de conmutación. | Åström & Murray *Feedback Systems* (MIT) `https://introcontrol.mit.edu/_static/fall21/extras/Feedback%20Systems%20Murray.pdf`; MathWorks `https://www.mathworks.com/help/mcb/gs/open-loop-and-closed-loop-control.html`; ISA `https://www.isa.org/intech-home/2023/june-2023/features/fundamentals-pid-control`; NI `https://www.ni.com/en/shop/labview/pid-theory-explained.html`; MIT pole-zero `https://web.mit.edu/2.14/www/Handouts/PoleZero.pdf` | Preservado desde la rama 3; **no se volvió a buscar en la síntesis** (ver §8). |

El índice interno del repo ya mapea estos papers a prácticas de workflow, incluyendo "loops with an explicit brake … must have a stop condition: max rounds, quiet rounds, maxAgents, timeout, or budget" (`docs/research/2026-06-25-agentic-patterns-papers-workflows.md:51-52`, derived-principle 6).

## 4. Principios centrales de loop engineering

Sintetizados a partir de las fuentes anteriores y verificados contra el repo (§6). Cada principio empareja un ancla de literatura/teoría con el mecanismo del repo.

1. **Terminación acotada (sin loops infinitos).** Todo loop necesita una condición de parada. Reflexion acota la memoria; Self-Refine acota iteraciones ([2303.11366](https://arxiv.org/abs/2303.11366), [2303.17651](https://arxiv.org/abs/2303.17651)). Repo: pandi-goal declara "Never an infinite loop" (`extensions/pandi-goal/index.ts:51`).
2. **Caps de iteración / tiempo / presupuesto (defensa en profundidad).** Múltiples frenos independientes: deadline estricto de wall-clock, cuenta de iteraciones y un cap de presupuesto de contexto best-effort (`extensions/pandi-loop/caps.ts:20-40`; `extensions/pandi-loop/index.ts:416-419`, `:486-490`), más un watchdog "zombie backstop" por encima del deadline (`extensions/pandi-loop/index.ts:1046-1074`).
3. **Clamping de cadencia ("never trust the model").** El valor de actuator elegido por el modelo (delay) se *satura* a una banda segura — el análogo en loops agénticos del actuator-limiting para evitar una ganancia desestabilizante ([NI PID](https://www.ni.com/en/shop/labview/pid-theory-explained.html)). Repo: la cadencia dinámica se clampa a `[60,3600]s` (`extensions/pandi-loop/index.ts:1253-1259`); el intervalo fijo se clampa a `[1s,24h]` y se rechaza `0s` (`extensions/pandi-loop/interval.ts:17-40`).
4. **Convergencia / quiet-rounds (settle-to-tolerance).** Parar cuando el "error" medido (hallazgos nuevos) se mantiene ≈0 durante K muestras consecutivas — un detector discreto de asentamiento, el análogo closed-loop de una respuesta amortiguada que se asienta dentro de tolerancia ([MIT pole-zero](https://web.mit.edu/2.14/www/Handouts/PoleZero.pdf)). Repo: `loop-until-done` usa `quietRounds` por defecto 2 y `maxRounds` por defecto 8 (`templates.ts:351-359`).
5. **Reanudabilidad.** Estado de loop/goal persistido y rehidratable con un *único* tick de catch-up (sin ráfaga de despertares perdidos) (`extensions/pandi-loop/index.ts:966-968`; `extensions/pandi-goal/index.ts:484-545,852-865`).
6. **Gate de acciones destructivas.** El autopilot (disparado por wake) gatea acciones claramente irreversibles o de gran radio de impacto; los turnos humanos nunca se gatean; el sesgo es "cuando hay duda, no bloquear" (`extensions/pandi-loop/gate.ts:16-59,75-117`).
7. **Progreso + verificación INDEPENDIENTE.** La lección decisiva de Huang et al.: que un modelo juzgue su propio razonamiento es poco confiable, así que los loops deben cerrarse sobre una señal *externa*. Repo: verificación en dos etapas — un chequeo de completitud SELF (`verifying`) y luego un subagent adversarial separado, de solo lectura, que emite `VERDICT: PASS|FAIL` (`verifying-independent`); solo un PASS independiente cierra el goal (`extensions/pandi-goal/index.ts:34-55,221-315,733-757`).
8. **Sin caps silenciosos.** Un loop que se detiene por presupuesto pero reporta "done" oculta incompletitud. Repo registra `"stopped at maxRounds (not dry)"` (`templates.ts:392-394`).

## 5. Modos de falla y mitigaciones

| Modo de falla | Mecanismo / fuente | Mitigación del repo (file:line) |
|---|---|---|
| **Runaway / token-burn** | Loop sin límites sobre un evaluator defectuoso; Reflexion no da garantía de convergencia ([2303.11366](https://arxiv.org/abs/2303.11366)). | Caps de wall-clock + iteración + contexto `extensions/pandi-loop/caps.ts:20-40`, `extensions/pandi-loop/index.ts:416-419`; backstop watchdog `extensions/pandi-loop/index.ts:1046-1074`; `maxRounds` `templates.ts:352`. |
| **Oscillation / limit cycle** (se declara done → se rechaza → repite) | Oscilación marginal/sostenida sin damping ([MIT pole-zero](https://web.mit.edu/2.14/www/Handouts/PoleZero.pdf)); necesita un conteo duro de cambios, no mejor tuning. | `maxIndependentVerifications` (default 2) → `blocked` `extensions/pandi-goal/constants.ts:58-64`, `extensions/pandi-goal/index.ts:279-291`; cap de auto-chequeo `MAX_VERIFY_ATTEMPTS=3` `extensions/pandi-goal/constants.ts:43-49`. |
| **No-progress / livelock** | Rondas quietas/vacías que nunca convergen. | Detector de quiet rounds + cap `maxRounds` `templates.ts:359`, `:389-394`. |
| **Parada prematura (falsa convergencia)** | Una sola ronda transitoriamente quieta cambia el estado. | Requiere **dos** quiet rounds (deadband) antes de parar `templates.ts:351`; conservador-FAIL-en-ambigüedad `extensions/pandi-goal/index.ts:770-787`. |
| **Overlap / reentrancy** | Despertares concurrentes compitiendo por el turno. | Serialización FIFO de wakeups no superpuestos `extensions/pandi-loop/index.ts:405-422,427-440`; single catch-up tick `extensions/pandi-loop/index.ts:966-968`; clamp a 0 para timestamps pasados `extensions/pandi-loop/time.ts:20-24`. |
| **Critique-gaming / reward-hacking** (actor == critic) | La autocorrección intrínseca puede degradar resultados ([Huang et al., 2310.01798](https://arxiv.org/abs/2310.01798)). | Verificador INDEPENDIENTE de solo lectura; "a claim without verifiable evidence is a FAIL" `extensions/pandi-goal/index.ts:620-625`; el veredicto se ancla a la última línea no vacía para que no se pueda falsificar un PASS repitiendo el prompt `extensions/pandi-goal/verifier.ts:105-141`; exit no cero + PASS se trata como FAIL `extensions/pandi-goal/verifier.ts:172-183`. |

## 6. Fundamento en este repo

Todos los `file:line` fueron verificados en este run. **Alignment** = el mecanismo coincide con el principio; **Gap** = limitación/discrepancia.

| Principio / falla | Superficie del repo (file:line) | Alignment vs gap |
|---|---|---|
| Terminación acotada | `extensions/pandi-goal/index.ts:51` ("Never an infinite loop"); `templates.ts:359` (`while quiet<… && round<…`) | **Aligned.** |
| Caps de wall-clock + presupuesto, chequeados antes de rearme | `extensions/pandi-loop/caps.ts:20-40` (doc + `capExceeded`); llamado en `extensions/pandi-loop/index.ts:416-419`, `:473-476`, `:959-963` | **Aligned.** El cap de presupuesto best-effort **hace no-op en silencio** cuando `getContextUsage()` es undefined o `percent` es null (`extensions/pandi-loop/caps.ts:36-40`) → **gap parcial** (sensor blando, no garantía). |
| Cap de iteración (gate separado) | `extensions/pandi-loop/index.ts:416-419`, `:486-490`; `maxIterations=25` por defecto (docstring `:72`); pandi-goal default 30 (`extensions/pandi-goal/constants.ts:32-40`) | **Aligned** — el cap es un gate distinto de `capExceeded`, como dice la read-list. |
| Clamp de cadencia `[60,3600]s` (dinámica) | `extensions/pandi-loop/index.ts:1253-1259` (`MAX_DELAY_SECONDS=3600`) | **Aligned, pero la read-list es incorrecta:** este clamp está en `index.ts`, **no** en `interval.ts`. |
| Clamp de intervalo fijo `[1s,24h]`, rechazo de `0s` | `extensions/pandi-loop/interval.ts:17-40` | **Aligned.** |
| Convergencia por quiet rounds | `templates.ts:351` (`quietToStop=2`), `:389` (`quiet = fresh===0 ? quiet+1 : 0`) | **Aligned**, pero como heurística empírica, no como convergencia demostrada (ver §7). |
| Sin caps silenciosos | `templates.ts:392-394` (`"stopped at maxRounds (not dry)"`) | **Aligned.** |
| Reanudabilidad / single catch-up | `extensions/pandi-loop/index.ts:966-968`; `extensions/pandi-goal/index.ts:484-545,852-865` (rehydrate, re-run verifier on a `verifying-independent` snapshot) | **Aligned.** |
| Reentrancy / serialización | `extensions/pandi-loop/index.ts:405-422,427-440`; `extensions/pandi-loop/time.ts:20-24` | **Aligned.** |
| Gate de acciones destructivas (solo autopilot) | `extensions/pandi-loop/gate.ts:58-59,75-117,196-219` (allowlist + policy), `isUnsafeWritePath` `extensions/pandi-loop/gate.ts:196-219` | **Aligned.** El sesgo conservador es deliberado; el riesgo simétrico es la sobre-permisividad ante comandos destructivos nuevos no incluidos en la allowlist (ver §7). |
| La verificación independiente cierra el goal | `extensions/pandi-goal/index.ts:34-55,221-315,733-757` (state `verifying-independent`, `runIndependentVerifier`, PASS→done / FAIL-under-cap→continue / FAIL-at-cap→blocked) | **Aligned — strongest surface.** Responde directamente a Huang et al. |
| Parseo conservador del veredicto | `extensions/pandi-goal/verifier.ts:105-141` (ancla la última línea no vacía), `extensions/pandi-goal/verifier.ts:131-141` (sin veredicto → FAIL), `extensions/pandi-goal/verifier.ts:172-183` (exit≠0 + PASS → FAIL) | **Aligned.** |
| Máquina de estados | `extensions/pandi-goal/index.ts:25-55` (`pursuing → verifying → verifying-independent → done\|blocked`) | **Aligned** con la descripción de la read-list. |
| Índice propio de principios de loop del repo | `docs/research/2026-06-25-agentic-patterns-papers-workflows.md:51-52` ("Loops with an explicit brake"), `:9-12` (paper→pattern map) | **Aligned**; ReAct/Reflexion/Self-Refine están mapeados. ReAct fue re-verificado de forma independiente en el source pass del 2026-06-28 (Yao et al., ICLR 2023, arXiv:2210.03629). |

## 7. Gaps, limitaciones y observaciones OPCIONALES (sin diffs)

Solo observaciones; no se proponen cambios de código.

**Actualización — observaciones aplicadas (2026-06-28).** Un seguimiento aplicó los ítems seguros y quirúrgicos de abajo: **#3** (inexactitud de la read-list) se corrigió en la grounding read-list del workflow de investigación y en los prompts del reviewer (`.pi/workflows/drafts/loop-engineering-deep-research.js`) para que un re-run ya no atribuya erróneamente el clamp dinámico `[60,3600]s` a `interval.ts`; **#6** (dos caps de verificación distintos) y **#5** (costo del verificador independiente) se abordaron con comentarios de cruce sobre `MAX_VERIFY_ATTEMPTS` (`extensions/pandi-goal/constants.ts:43-49`) y `DEFAULT_MAX_INDEPENDENT_VERIFICATIONS` (`extensions/pandi-goal/constants.ts:58-64`). **#1** se dejó igual: `extensions/pandi-loop/caps.ts:20-40` ya documenta el best-effort/silent no-op en su docstring. **#2** (eval sweep de `quietRounds`/`maxRounds`) y **#4** (allowlist finita del destructive-gate) siguen abiertos por diseño — el primero necesita datos, el segundo es una asimetría aceptada deliberada. La guía práctica derivada de esta investigación vive en [`docs/loop-engineering-with-extensions.md`](../loop-engineering-with-extensions.md).

1. **El cap best-effort de presupuesto es un sensor blando.**
   Cuando `getContextUsage()` no está disponible, solo quedan los frenos de wall-clock + iteración (`extensions/pandi-loop/caps.ts:36-40`). *Observación opcional:* conviene documentar (ya parcialmente hecho en el docstring) que el cap de contexto puede hacer no-op en silencio, para que los operadores no confíen demasiado en él.
2. **Quiet-rounds ≠ convergencia demostrada.**
   `quiet===2` es un debounce/deadband, no una garantía de fixed-point/contraction; una quietud transitoria (buscadores buscando el lugar equivocado) puede disparar una falsa parada (`templates.ts:351`, `:389`). *Opcional:* el tradeoff precisión vs costo de los defaults `quietRounds`/`maxRounds` parece basado en criterio, no en datos — un eval sweep lo convertiría en evidencia.
3. **Inexactitud de la read-list (gap documental, no bug de código).**
   La grounding read-list atribuye el clamp dinámico `[60,3600]s` a `extensions/pandi-loop/interval.ts`; en realidad vive en `extensions/pandi-loop/index.ts:1253-1259`. Solo el clamp fijo `[1s,24h]` está en `extensions/pandi-loop/interval.ts:17-40`. *Opcional:* corregir la read-list/comentarios para futuros lectores.
4. **La allowlist del destructive-gate es finita.** `extensions/pandi-loop/gate.ts:58-59,75-117,196-219` enumera patrones conocidos como peligrosos con sesgo "when unsure, do not block"; un comando destructivo nuevo fuera de la allowlist pasa en autopilot. Es una asimetría aceptada deliberadamente, no un defecto.
5. **Costo del verificador independiente.**
   Cada paso `verifying-independent` lanza un proceso separado `pi -p` (`extensions/pandi-goal/index.ts:236-315`). Huang et al. advierten que la crítica multironda debería compararse contra baselines más baratos (por ejemplo, self-consistency). *Opcional:* conviene explicitar que más rondas de verificación no son gratis.
6. **Dos caps de verificación distintos pueden confundir.**
   `MAX_VERIFY_ATTEMPTS=3` (auto-chequeo de completitud) vs `DEFAULT_MAX_INDEPENDENT_VERIFICATIONS=2` (independiente) son gates distintos (`extensions/pandi-goal/constants.ts:43-49`, `extensions/pandi-goal/constants.ts:58-64`). Correcto e intencional, pero merece una cross-reference de una línea para mantenedores.

## 8. Brechas de cobertura y qué verificar después

**Ramas fallidas/vacías (conteo honesto):**
- `research-react-observe-act` — **VACÍA en el run original; RESUELTA 2026-06-28.** ReAct (arXiv:2210.03629) ahora está confirmado por fuente primaria: Yao, Zhao, Yu, Du, Shafran, Narasimhan, Cao; v3 = **ICLR 2023** camera-ready; intercala trazas de razonamiento, acciones y observaciones del entorno; evaluado en HotpotQA, FEVER, ALFWorld y WebShop ([abstract](https://arxiv.org/abs/2210.03629), [sitio oficial](https://react-lm.github.io/)).
- `research-bounding-failure-modes-term` — **VACÍA.** El sintetizador completó la pregunta sobre el término con su propia búsqueda web (§2, 5 fuentes). *Verificar después:* un pase dedicado de taxonomía de failure modes para paridad con las otras ramas.
- `research-repo-grounding` — **VACÍA.** El sintetizador la completó leyendo directamente cada archivo de la read-list (todos los `file:line` aquí fueron verificados en este run).

**Otros ítems para verificar:**
- **Las URLs de teoría de control se preservaron desde la rama 3 y NO se volvieron a buscar en la síntesis** (el presupuesto web de la síntesis se gastó en la pregunta sobre el término). Tratá las mapeos F1–F7 como *interpretación respaldada por las citas de la rama 3*, pendiente de una re-búsqueda independiente de Åström & Murray / MathWorks / ISA / NI / MIT.
- **No se encontró una formalización teórico-control de loops LLM revisada por pares.** Los mapeos "quiet rounds = settling/deadband" y "clamp = actuator saturation" son **analogías (INTERPRETATION)**, no resultados probados de contraction/fixed-point. *Verificar después:* buscar trabajos que modelen la iteración de refinamiento como una contraction mapping con una cota de convergencia.
- **Debate sobre autocorrección — contraargumentos ya leídos (RESUELTO 2026-06-28).** Huang et al. ([2310.01798](https://arxiv.org/abs/2310.01798)) se sostiene para loops intrínsecos *ingenuos/sesgados*. [arXiv:2405.14092](https://arxiv.org/abs/2405.14092) (Wu et al., EMNLP 2024 — *ProCo*) muestra que la autocorrección intrínseca estructurada (ocultar una condición clave → verificar → resolver de nuevo) supera la autocorrección simple (+6.8 EM QA / +14.1 arithmetic / +9.6 commonsense, GPT-3.5-Turbo-1106); [arXiv:2406.15673](https://arxiv.org/abs/2406.15673) (Liu et al.) informa que la autocorrección intrínseca funciona a **temperature 0 con prompts no sesgados**, mientras que prompts sesgados del tipo "find problems" revierten respuestas correctas (límites: 4 modelos, 2 datasets, sin error bars). Conclusión: acotar el loop *y* mantener la señal de crítica independiente/no sesgada — exactamente lo que impone el verificador externo de pandi-goal.
- **Límite de iteraciones de Self-Refine y repo de Reflexion (RESUELTO 2026-06-28).** Self-Refine corre hasta una señal de parada de la tarea **acotada a 4 iteraciones** en los experimentos del paper (§3.1; Fig 4 muestra rendimientos decrecientes después de ~3 iteraciones) ([arXiv:2303.17651](https://arxiv.org/pdf/2303.17651)). ⚠️ El repo citado por el paper de Reflexion `https://github.com/noahshinn024/reflexion` **ya no aloja el código original** — actualmente muestra un proyecto no relacionado "Bugbounty POC" (~2 commits); tratá esa URL como una cita vieja o reutilizada y preferí el PDF del paper ([arXiv:2303.11366](https://arxiv.org/pdf/2303.11366)).

---

*No se editaron archivos de código fuente. Toda afirmación externa lleva una URL; toda afirmación del repo lleva `file:line` verificado en este run; los ítems no verificables están marcados como INSUFFICIENT_EVIDENCE o INTERPRETATION.*
