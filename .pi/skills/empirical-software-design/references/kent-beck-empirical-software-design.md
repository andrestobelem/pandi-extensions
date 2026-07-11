# Resumen de diseño empírico de software según Kent Beck

Investigación fuente: cuatro ramas de research del proyecto sobre Kent Beck (`method-mechanics`, `decision-economics`,
`pitfalls-criticisms`, `modern-ai-application`), apoyadas en _Test-Driven Development: By Example_ (2002), _Tidy First?_
(2023) y newsletters de Beck.

## Canon de TDD

Reformulación definitiva de Beck en 2023: (1) escribir una lista de tests con las variantes de comportamiento esperadas;
(2) convertir exactamente un ítem en un test concreto y ejecutable; (3) hacer pasar todos los tests, actualizando la
lista a medida que aprendés; (4) refactorizar de forma opcional; (5) repetir hasta vaciar la lista. En el canon, el paso
4 es explícitamente opcional.

## Gears de green bar

De la Parte III de _TDD: By Example_ (vía notas de capítulos): Obvious Implementation (escribir el código real cuando
está claro y es rápido), Fake It (devolver una constante y luego reemplazar constantes por variables), Triangulate
(generalizar solo cuando dos o más ejemplos lo fuerzan). Estos gears ajustan el tamaño del paso: más grande cuando hay
confianza, más chico cuando un red bar te sorprende.

## TCR

`test && commit || revert`: correr tests después de cada cambio diminuto; con green se hace commit, con red se revierte
al último estado que pasaba. Beck lo presentó como un experimento para forzar incrementos más chicos (Medium, 2018).
Thoughtworks Radar lo clasifica como "Trial": pasos diminutos, tests rápidos y deterministas, tolerancia al riesgo.
Sobre si Beck avala TCR como práctica sostenida: INSUFFICIENT_EVIDENCE.

## _Tidy First?_ — estructura vs. comportamiento

- Los tidyings cambian estructura, nunca comportamiento; mantenelos en commits/PRs separados y con pocos tidyings por PR
  (ch. 16; ch. 28 "Reversible Structure Changes").
- Valor = comportamiento hoy + opciones sobre comportamiento futuro; el valor temporal empuja a entregar comportamiento
  ahora, mientras que la optionality justifica invertir en estructura (Parte III).
- Coupling: que el cambio en un elemento obligue a cambiar otro, respecto de un cambio probable concreto (ch. 29,
  paráfrasis). Cohesion: poner juntos los elementos que cambian juntos (ch. 32).
- Timing (ch. 21; post "First, After, Later, Never"): First cuando baja el costo/riesgo del cambio inmediato o hace
  falta para entender el código; After cuando vas a tocar esa zona otra vez pronto; Later cuando el beneficio es real
  pero diferible y rastreable; Never cuando ese código no va a cambiar.
- Test económico (paráfrasis vía notas del libro): hacer tidy first cuando cost(tidying) + cost(change after) <
  cost(change without). Fórmulas exactas de DCF/options: INSUFFICIENT_EVIDENCE.

## Los 15 tidyings (Parte I)

Guard Clauses; Dead Code; Normalize Symmetries; New Interface, Old Implementation; Reading Order; Cohesion Order; Move
Declaration and Initialization Together; Explaining Variables; Explaining Constants; Explicit Parameters; Chunk
Statements; Extract Helper; One Pile; Explaining Comments; Delete Redundant Comments (TOC de O'Reilly).

## Cuatro reglas del diseño simple

Están ordenadas por prioridad; las fuentes discrepan sobre las dos del medio. _XP Explained_ 1st ed. p. 57 (vía Fowler):
runs all the tests → no duplicated logic → states every intention → fewest classes/methods. Shorthand de Fowler,
revisado por Beck: passes the tests → reveals intention → no duplication → fewest elements. Las reglas 1 y 4 son
estables. Redacción verbal exacta: INSUFFICIENT_EVIDENCE.

## 3X: Explore / Expand / Extract

Explore (payoff desconocido): muchos experimentos baratos, chicos y no correlacionados; optimizar aprendizaje; tolerar
código descartable. Expand: foco singular en el siguiente cuello de botella para crecer. Extract: optimizar margen,
confiabilidad y repetibilidad mediante estandarización y automatización. Cada fase trae herramientas y sistemas de valor
distintos, y no pueden mezclarse con seguridad. No hay mapeo de prácticas por fase respaldado por fuente:
INSUFFICIENT_EVIDENCE.

## Límites y malos usos (caveats del propio Beck)

- Profundidad de tests basada en confianza (Stack Overflow, 2008, paráfrasis): testear lo mínimo necesario para alcanzar
  un nivel dado de confianza; más donde es probable equivocarse, menos donde una clase de errores empíricamente no
  aparece.
- El valor de TDD se degrada con tests lentos, fallas con muchas causas posibles, tests acoplados a la implementación y
  entornos de baja fidelidad ("Is TDD Dead?", 2014).
- TDD no toma decisiones de diseño por vos (paráfrasis, "TDD Outcomes"). Patrón de mal uso: test-induced design damage —
  indirección agregada solo para aislar tests; la respuesta de Beck es culpar al juicio de diseño, no a TDD (DHH 2014;
  registro del debate en Fowler).

## Augmented coding (2024–2025)

- La IA desplaza costos, no corrección; la respuesta es hacer muchos experimentos chicos y ciclos rápidos de feedback
  ("Exploring AI").
- Augmented ≠ vibe coding: la persona sigue siendo responsable de complejidad, tests, coverage y tidy design ("Beyond
  the Vibes").
- Los tests funcionan como guardrails ejecutables y binarios para agentes; conviene mantener corriendo de forma
  constante una suite grande y rápida (entrevista en Pragmatic Engineer, 2025).
- Reglas de persistent prompting: no code without a failing test; only enough code to pass; green before commit; never
  delete tests.
- Lista de fallas a vigilar ("Genie Wants to Leap"): loops, scope no pedido, tests/assertions borrados, implementaciones
  fake.
- Copy-from-simpler-language: implementar primero en Python y luego hacer que el agente traduzca tests y código.
- Outcomes over orchestration ("Genie Lessons: Nobody Wants Agents").
- Ninguna fuente primaria vincula TCR con agentes: INSUFFICIENT_EVIDENCE.

## Política de citas y huecos

La única cita textual licenciada es el tuit de Beck de 2012: "for each desired change, make the change easy (warning:
this may be hard), then make the easy change" ("para cada cambio deseado, hacé que el cambio sea fácil — advertencia:
esto puede ser difícil — y después hacé el cambio fácil"). Todo el wording de los libros debe ir parafraseado y
atribuido. El lado humano/social del diseño tiene respaldo de fuentes más fino (economía de review en ch. 16;
outcomes-over-orchestration); no extrapolar más allá de eso.

## Fuentes

- https://tidyfirst.substack.com/p/canon-tdd
- https://medium.com/@kentbeck_7670/test-commit-revert-870bbd756864
- https://www.oreilly.com/library/view/tidy-first/9781098151232/
- https://newsletter.kentbeck.com/p/first-after-later-never
- https://newsletter.kentbeck.com/p/the-product-development-triathlon
- https://newsletter.kentbeck.com/p/exploring-ai
- https://tidyfirst.substack.com/p/augmented-coding-beyond-the-vibes
- https://newsletter.kentbeck.com/p/genie-wants-to-leap
- https://newsletter.kentbeck.com/p/persistent-prompting
- https://newsletter.kentbeck.com/p/augmented-coding-technique-copy-from
- https://tidyfirst.substack.com/p/genie-lessons-nobody-wants-agents
- https://newsletter.kentbeck.com/p/tdd-outcomes
- https://newsletter.pragmaticengineer.com/p/tdd-ai-agents-and-coding-with-kent
- https://martinfowler.com/bliki/BeckDesignRules.html
- https://martinfowler.com/articles/is-tdd-dead/
- https://stanislaw.github.io/2016-01-25-notes-on-test-driven-development-by-example-by-kent-beck.html
- https://danlebrero.com/2024/08/07/tidy-first-summary/
- https://guidefari.com/tidy-first/
- https://www.thoughtworks.com/en-us/radar/techniques/tcr-test-commit-revert
- https://stackoverflow.com/questions/153234/how-deep-are-your-unit-tests/153565#153565
- https://dhh.dk/2014/test-induced-design-damage.html
- https://x.com/KentBeck/status/250733358307500032
