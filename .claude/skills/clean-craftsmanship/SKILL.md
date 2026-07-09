---
name: clean-craftsmanship
description: >-
  Aplica el clean craftsmanship al estilo Robert C. Martin ("Uncle Bob") al
  escribir o revisar código por legibilidad (nombres, funciones,
  comentarios), al diagnosticar pudrición de diseño con los principios SOLID
  y de componentes, al chequear los límites de Clean Architecture y la
  Dependency Rule, o al ejercer disciplinas de profesionalismo (las tres
  leyes de TDD como disciplina, saber decir que no, estimaciones honestas,
  limpieza tipo Boy Scout). Usar cuando la pregunta es sobre oficio a nivel
  de código, dirección de dependencias, si un límite justifica su costo, o
  conducta profesional bajo presión de cronograma.
---

# Clean Craftsmanship

Usá este skill cuando una tarea pida oficio a nivel de código o juicio profesional: estructura de nombres y funciones, política de comentarios, detección de pudrición de diseño, chequeo de dirección de dependencias, decidir si una interfaz o capa justifica su costo, o manejar estimaciones, compromisos y presión de cronograma con honestidad.

Este skill se basa en la investigación del proyecto destilada del blog Clean Coder de Robert C. Martin, el paper de 2000 "Design Principles and Design Patterns", *Clean Code* (cap. 1–3) y *The Clean Coder*, más críticas documentadas y las respuestas del propio Martin a ellas. Ver `references/uncle-bob-clean-craftsmanship.md` para el resumen compacto de fuentes.

Este skill es dueño del oficio de Martin a nivel de código, los diagnósticos de diseño y las disciplinas de profesionalismo. `modern-software-engineering` es dueño de TDD como el loop de feedback por defecto de este repo y de la forma de respuesta requerida — deferí a él para decidir si y cuándo aplica TDD. `empirical-software-design` es dueño del micro-ritmo fino de TDD y de la economía de timing de tidy first/after/later/never — el Boy Scout rule acá cubre solo limpieza al pasar y deriva esa apuesta a ese skill. `ai-assisted-engineering` es dueño de la decisión de delegar a IA; este skill solo agrega el gate de Martin de tests en verde antes de refactor por IA.

## Lente central

1. **Ir bien es la única forma de ir rápido.** El código desprolijo eleva el costo de cada cambio futuro, alimentando un loop de entregas más lentas, más presión de cronograma y más desprolijidad ("Going Fast", 2007; *Clean Code* cap. 1). El craftsmanship es negarse a hacer trabajo pobre o generar desorden para cumplir un cronograma (2011).
2. **La disciplina elimina la discreción.** Cada regla restringe qué podés hacer a continuación en una escala de tiempo específica, haciendo que la calidad sea el default en vez de un acto de voluntad — las tres leyes de TDD fuerzan diseño testeable y desacoplado como efecto secundario.
3. **La pudrición tiene exactamente cuatro síntomas, todos rastreables a dependencias mal gestionadas.** Rigidez, fragilidad, inmovilidad y viscosidad (de diseño y de entorno) son el diagnóstico; SOLID y los principios de componentes son el tratamiento (paper de 2000).
4. **Las dependencias del código fuente apuntan hacia adentro.** Ese es el único invariante de arquitectura; el diagrama de círculos concéntricos es esquemático, no un número obligatorio de capas (Martin, 2012).
5. **Un desorden no es deuda técnica.** La deuda puede ser un trade-off deliberado y razonado que se paga con disciplina; el desorden es pérdida pura sin contrapartida ("A Mess is not a Technical Debt").
6. **Los profesionales se comunican con honestidad.** Una estimación es una distribución de probabilidad; un compromiso es una promesa; decir "voy a intentarlo" bajo presión es un compromiso implícito encubierto (*The Clean Coder*).

## Las disciplinas

1. **Las tres leyes de TDD, como restricción profesional.** Parafraseadas (la redacción textual no está verificada en la investigación — nunca cites): escribí código de producción solo para hacer pasar un test que falla; no escribas de un test más de lo que basta para que falle, contando fallas de compilación; no escribas más código de producción del que basta para pasar el único test que falla. Martin anida esto como el nano-ciclo dentro de Red–Green–Refactor ("The Cycles of TDD", 2014). Si TDD es el loop para este cambio es decisión de Farley; el tamaño de paso y los movimientos de diseño dentro del loop son de Beck; este lane aporta las leyes como disciplina.
2. **Selección de paso en verde (Transformation Priority Premise).** Al hacer pasar un test, preferí la transformación de código más simple de la lista ordenada de Martin (constante antes que escalar, `if` antes que `while`, recursión tarde); si un test fuerza una transformación de baja prioridad, considerá otro test (posts de TPP, 2013).
3. **Oficio de legibilidad.** Funciones: chicas; que hagan una sola cosa; un nivel de abstracción por función; la stepdown rule (el código se lee de arriba hacia abajo); pocos argumentos; sin efectos secundarios; separación comando–consulta; excepciones en vez de códigos de error; DRY (*Clean Code* cap. 3). Los nombres llevan la intención; Martin trata un comentario como un fallo en expresar intención en el código (documentado en el debate Ousterhout–Martin), así que probá renombrar/extraer antes de anotar.
4. **Boy Scout rule — solo limpieza al pasar.** Dejá un módulo un poco más limpio de como lo encontraste (*97 Things* cap. 8; *Clean Code* cap. 1), manteniendo la limpieza continua y amortizada. Acotala a mejoras chicas y oportunistas dentro del cambio que ya estás haciendo; cualquier apuesta más grande de tidy-first/after/later/never deriva a `empirical-software-design`.
5. **Diagnosticá la pudrición antes de prescribir principios.** Buscá los cuatro síntomas con evidencia concreta, rastrealos hasta las dependencias, y aplicá SOLID y los principios de componentes donde aparecen síntomas — no en todos lados preventivamente (paper de 2000; defendido en "Solid Relevance", 2020). No hay un orden de prioridad canónico entre los principios SOLID en las fuentes; no los rankees.
6. **Dependency Rule y límites.** Mantené las dependencias del código fuente apuntando hacia adentro; cruzá los límites vía interfaces propiedad del lado interno (Dependency Inversion). Una buena arquitectura mantiene barato cambiar de framework, base de datos y UI tratándolos como detalles en los bordes (posts de 2011, 2012).
7. **Conducta profesional.** Decí que no en vez de "voy a intentarlo"; separá estimaciones de compromisos; cuantificá la incertidumbre con estimaciones trivariadas PERT, media (O + 4N + P) / 6 y dispersión (P − O) / 6 (*The Clean Coder* cap. 10); aceptá deuda solo de forma deliberada, visible y con plan de repago — nunca como desorden.

## Forma de respuesta requerida al usar este skill

Para revisiones de oficio, diagnósticos de diseño o decisiones de profesionalismo, incluí esto salvo que sea claramente irrelevante:

- **Veredicto de legibilidad:** si los nombres, funciones y estructura expresan intención, con la regla específica violada (p. ej. niveles de abstracción mezclados, efectos secundarios).
- **Síntomas de pudrición:** cuáles de los cuatro se observan, cada uno atado a evidencia de código y a la dependencia que lo causa.
- **Dirección de dependencias:** hacia dónde apuntan las dependencias del código fuente en cada límite tocado, y cualquier violación de la regla hacia adentro.
- **Justificación del límite:** qué paga cada interfaz/capa (segunda implementación, volatilidad del adaptador, complejidad de dominio) — o una recomendación de eliminarla.
- **Estado honesto del compromiso:** si la respuesta dada es una estimación (con incertidumbre) o un compromiso, y sin "voy a intentarlo".
- **Alcance de la limpieza:** qué limpieza tipo Boy Scout viaja al pasar; cualquier cosa más grande, nombrada y derivada a la decisión de timing del skill de Beck.

## Cómo aplicarlo

1. **Leé primero para intención.** ¿Podés seguir el código de arriba hacia abajo sin saltar? Arreglá nombres y extracción antes que nada estructural.
2. **Diagnosticá antes de prescribir.** Nombrá el síntoma de pudrición y la dependencia mal gestionada detrás; solo entonces recurrí a un principio o patrón.
3. **Chequeá la dirección en cada límite.** El código interno no debe nombrar ni conocer código externo; cruzá con interfaces propiedad del lado interno.
4. **Hacé que cada abstracción pague su renta.** Justificá cada interfaz o capa con una fuerza concreta; eliminá las especulativas.
5. **Limpiá al pasar.** Dejá los módulos tocados un poco más limpios; mantené la limpieza dentro del radio de impacto del cambio actual.
6. **Mantené la comunicación honesta.** Dá rangos, no promesas; escalá pedidos imposibles con un "no" más alternativas en vez de heroísmo silencioso.
7. **Condicioná el refactor por IA a tests en verde.** La práctica de IA de Martin, según fuentes (entrevista con Duffield, 2024): entregale código a la IA para refactorizar solo después de que todos los tests pasen, y aceptá el resultado solo con juicio humano. Si delegar o no es decisión de `ai-assisted-engineering`.

**Cierre:** terminá cuando cada hallazgo aplicable tenga evidencia de código o dependencia, los límites tocados tengan dirección y renta explícitas, y la limpieza o el compromiso queden acotados y comunicados honestamente. No exijas ejes que no aplican al cambio.

## Checklist de revisión

- **Nombres:** ¿revelan intención, o el lector necesita un comentario o mirar la implementación?
- **Funciones:** ¿chicas, hacen una sola cosa, un nivel de abstracción, pocos argumentos, sin efectos secundarios ocultos, comando–consulta separados?
- **Comentarios:** ¿cada comentario hace un trabajo que el código no puede, o compensa una intención expresable?
- **Duplicación:** ¿hay conocimiento repetido que debería vivir en un solo lugar?
- **Rigidez:** ¿los cambios chicos se propagan en cascada por módulos dependientes?
- **Fragilidad:** ¿los cambios rompen lugares conceptualmente no relacionados?
- **Inmovilidad:** ¿lógica reusable atrapada por dependencias enredadas?
- **Viscosidad:** ¿el cambio que preserva el diseño es más difícil que el hack — o el entorno (builds/tests lentos) empuja a atajos?
- **Dirección:** ¿todas las dependencias del código fuente apuntan hacia adentro en los límites tocados?
- **Renta del límite:** ¿cada interfaz/capa tiene una segunda implementación, un adaptador volátil o complejidad de dominio que la paguen?
- **Disciplina:** ¿un test que falla precedió al código de producción (tres leyes)? Las preguntas de loop-por-defecto van a `modern-software-engineering`.
- **Honestidad:** ¿las estimaciones son distribuciones, los compromisos explícitos, y el desorden nunca se etiqueta como "deuda"?

## Guía para dynamic workflows

Específicamente para Pi Dynamic Workflows:

- Dale a las personas revisoras los cuatro síntomas de pudrición como sondas estructuradas; exigí que cada síntoma reclamado venga con evidencia de archivo/línea y la dependencia culpable, no adjetivos.
- La dirección de dependencias es verificable por máquina: preferí checks ejecutables (linters de dependencias, tests de arquitectura en build-time) por sobre la opinión de un subagente. Codificar estas reglas como guardrails de agente en archivos de instrucciones más checks de CI es una adaptación de la práctica (NimblePros y otros), no el método propio de Martin — atribuilo como tal.
- Los prompts solos son un enforcement débil: la investigación encontró código generado por LLM con mayor incidencia de code smells que las líneas base humanas, así que verificá las afirmaciones de oficio en CI/revisión, no por generación.
- Aplicá el saber-decir-que-no al scoping de workflows: cuando un alcance pedido es imposible dentro del presupuesto, reportalo con alternativas en vez de "intentarlo" y entregar de menos.
- Corré las ramas de refactor por IA solo contra suites que ya estén en verde, y exigí aceptación del diff por juicio humano.

## Antipatrones a señalar

- Layering de cargo-cult: stacks obligatorios de cuatro capas, interfaces con una sola implementación, o ceremonia de use-case/DTO en una feature CRUD delgada (un caso documentado: una app de dos pantallas dividida en 22 módulos). El propio post de Martin dice que los círculos son esquemáticos.
- Rankear los principios SOLID o aplicarlos como reglas incondicionales sin síntomas de pudrición observados.
- Decir "voy a intentarlo" bajo presión — un compromiso encubierto y deshonesto.
- Presentar un desorden como "deuda técnica" para legitimarlo.
- Comentarios que tapan nombres y funciones que podrían expresar la intención directamente.
- Limpieza tipo Boy Scout que se infla hasta convertirse en una reescritura no planeada dentro de un cambio no relacionado.
- Aceptar código refactorizado por IA sin una suite en verde antes y juicio humano después.

## Guardrails

- Llevá la propia salvedad de alcance de Martin: estas reglas cambian ciclos de CPU por ciclos de programador y pueden no encajar en código de GPU, inner-loop o crítico en performance (su concesión en el Q&A con Muratori). El late binding paga su costo sobre todo en límites de plugin/librería.
- El único invariante de arquitectura es que las dependencias del código fuente apunten hacia adentro; no exijas un número fijo de capas. Introducí interfaces/capas solo cuando una segunda implementación, la volatilidad del adaptador o la complejidad de dominio las pagan (heurística correctiva de los críticos, consistente con la salvedad esquemática de Martin).
- Parafraseá las tres leyes con atribución; la redacción textual de la página canónica no fue verificada en la investigación.
- La disciplina de acceptance-test/"QA no debería encontrar nada" ("prueba repetible") suele atribuirse a *The Clean Coder* pero no fue verificada en la investigación de fuentes — no la afirmes. Lo que sí está confirmado: Martin plantea que TDD juega un rol significativo en la conducta profesional sin convertirla en la única disciplina admisible ("Professionalism and TDD (Reprise)", 2014).
- La estructura interna del libro *Clean Craftsmanship* (2021) no fue confirmada directamente en las fuentes; este skill se apoya en los posts del blog, el paper de 2000, *Clean Code* cap. 1–3 y *The Clean Coder*.
- Deriví los lanes explícitamente: TDD-como-loop-por-defecto y la forma de respuesta del repo → `modern-software-engineering`; el micro-ritmo, las limpiezas y la economía de timing de tidy → `empirical-software-design`; la decisión de delegar en IA → `ai-assisted-engineering`.
