# Principios de ingeniería de este repo (pandi-extensions)

Destilado de `AGENTS.md`, `modern-software-engineering/SKILL.md`,
`ai-assisted-engineering/SKILL.md` y `karpathy-guidelines`. Reglas accionables, no slogans.

## En 30 segundos

Este documento resume las reglas de ingeniería que rigen este repo. Te sirve para decidir
cómo encarar un cambio, revisar una PR o coordinarte con IA sin perder verificabilidad.
Si hay varias opciones válidas, elegí el slice más chico, escribí/ejecutá tests y dejá
evidencia concreta.

## 1. Mentalidad (Karpathy)

- **Entendé antes de escribir código.** Declarar supuestos antes de implementar; si hay
  varias interpretaciones válidas, presentalas — no elijas en silencio. Si algo no está
  claro, frená y preguntá en vez de suponer.
- **La simplicidad se gana su lugar.** Escribí el mínimo código que resuelve el problema
  pedido: sin abstracciones de uso único, sin "flexibilidad" no pedida, sin manejo de
  errores para casos imposibles. Si 200 líneas podían ser 50, reescribilas.
- **Cambios quirúrgicos.** Tocá solo lo que el pedido exige: no "mejores" código adyacente
  ni refactorices lo que no está roto; igualá el estilo existente. Borrá solo lo que TU
  cambio dejó huérfano. Prueba: cada línea cambiada debe trazarse al pedido del usuario.
- **Metas verificables.** Convertí cada tarea en un criterio de éxito comprobable
  ("arreglar el bug" → "test que lo reproduce, luego hacerlo pasar"); en tareas
  multi-paso, enumerá plan + verificación por paso antes de ejecutar.

## 2. Disciplina de cambio (Farley / TDD)

- **TDD completo para cambios de comportamiento, no la mitad fácil:**
  1. **Red primero:** el test que falla se escribe ANTES de la implementación.
     Test-after no es TDD; si no podés ir test-first, decilo explícitamente.
  2. **Green:** cambio mínimo que hace pasar el test.
  3. **Refactor, nunca en silencio:** después de Green hacé siempre este paso y NARRÁ el
     resultado, incluso "nada que cambiar" (con el porqué) — los tests en verde son la
     red de seguridad que lo hace barato.
  4. **Commit** es la fase final: con Refactor en verde, commit atómico (Conventional
     Commits + scope), con el test de fijación en el MISMO commit que el código.
- **Optimizá para aprendizaje, no velocidad local:** elegí el slice reversible más chico y
  evitá reescrituras especulativas grandes. Buscá el feedback de alta calidad MÁS RÁPIDO
  (test que corre en segundos > suite lenta; check local > esperar CI completo). Cada
  cambio es una hipótesis; buscá evidencia (tests, CI, runtime, artifacts) antes que moda,
  intuición o "consenso" de IA.
- **La complejidad se gestiona en el Refactor, no como diseño especulativo:** revisá
  modularidad, cohesión, separación de responsabilidades, ocultamiento de información y
  acoplamiento.
- **Juzgá cada cambio por estabilidad + throughput.** Solo agregá burocracia, abstracción
  o configurabilidad con evidencia de que mejoran una de las dos sin degradar la otra.
  Reportá evidencia, no confianza: comandos ejecutados, resultados de test/CI o
  incertidumbre explícita.

## 3. Reglas del repo que NO son negociables

- **Extensiones self-contained → duplicación intencional.** Pi carga cada extensión como
  unidad autónoma (un archivo o su propio dir vía resolución de jiti); un `import` runtime
  a `../shared/` solo funciona con el monorepo completo presente y se rompe al instalarla
  standalone, por eso la duplicación entre extensiones (`pi-*/notify.ts`, `time.ts`,
  `session-state.ts`, parsers de flags) es DELIBERADA.
- **DRY solo intra-extensión.** `extensions/shared/` es solo para código de TEST harness,
  nunca runtime compartido entre extensiones. Al refactorizar, deduplicá solo DENTRO de
  una misma extensión/paquete.
- **Conventional Commits con scope explícito, siempre** (ej.
  `fix(pi-goal): clear terminated goals`), un cambio coherente por commit, con su test de
  fijación en el mismo commit.
- **Nunca `Co-Authored-By:` ni atribución de herramienta** en commits o PRs. Mensaje =
  subject Conventional-Commits + body, nada más.
- **Nunca `git commit --amend` a ciegas.** Sesiones/tabs concurrentes pueden haber puesto
  un commit encima del tuyo: verificá `git log`/`git reflog` antes de amendar, y solo si
  `HEAD` es con certeza tu propio commit. Si ya mezclaste cambios, recuperá con `reflog` +
  `git reset --soft` para separarlos.

## 4. IA y workflows dinámicos

- **Separá orquestador de workers.** `ai-assisted-engineering` es la lente del
  ORQUESTADOR (clasificar prototipo vs. producción, fijar el límite de delegación, scout +
  baseline antes de fan-out grande, tratar prompts/contexto/tools como el programa,
  verificar con evidencia ejecutable). `karpathy-guidelines` + `modern-software-engineering`
  aplican DENTRO de los WORKERS. No cargues las tres skills en cada subagente: matcheá la
  skill con el rol.
- **Vibe-codeá prototipos, nunca producción.** Producción exige especificación, permisos,
  revisión de diff, tests/evals, seguridad y un dueño humano; dejá explícito qué se validó
  de verdad.
- **Scout barato antes de fan-out grande.** Sondas de lectura antes de invocar un workflow
  multi-agente; usá `dynamic_workflow`/Ultracode solo si se justifica por escala,
  exhaustividad, verificación independiente o más contexto del que entra en una ventana.
- **Verificá con evidencia ejecutable, no consenso de agentes.** El output de un agente es
  una hipótesis: confirmalo con tests, evals, reproducción o revisión de diff antes de
  aceptarlo.
- **Artifacts inspeccionables, no magia oculta.** Cada rama del workflow devuelve
  artifacts concretos; las fallas parciales/vacías quedan visibles, no escondidas tras un
  resumen confiado. Workflows chicos, legibles y modificables (espíritu
  micrograd/nanoGPT); reusá uno existente solo si calza exactamente con la tarea.
