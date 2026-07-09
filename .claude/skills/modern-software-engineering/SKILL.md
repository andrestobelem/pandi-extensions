---
name: modern-software-engineering
description: >-
  Aplica principios de Modern Software Engineering al estilo Dave Farley al
  diseñar, revisar o mejorar sistemas de software, dynamic workflows, tests,
  pipelines de delivery o prácticas de ingeniería. Usar para optimizar el
  aprendizaje, hacer de TDD el loop de feedback por defecto para cambios de
  comportamiento, gestionar la complejidad y evaluar cambios por estabilidad más
  throughput.
---

# Ingeniería de Software Moderna

Usá este skill cuando una tarea pida criterio de ingeniería de software: arquitectura, refactoring, code review, estrategia de tests, mejoras de delivery/proceso, diseño de workflows o decidir si un cambio vale la pena.

Este skill se basa en la investigación del proyecto destilada desde _Modern Software Engineering: Doing What Works to Build Better Software Faster_ de Dave Farley y notas relacionadas. Ver `references/dave-farley-modern-software-engineering.md` para el resumen compacto de la fuente.

## Lente central

La ingeniería de software moderna es ciencia práctica aplicada al desarrollo de software:

1. **Optimizá para aprender.** Tratá cada cambio como una hipótesis y buscá el feedback de mayor calidad en el menor tiempo posible.
2. **Usá TDD para cambios de comportamiento.** Empezá con un check ejecutable que falle, hacelo pasar con el cambio más chico, refactorizá manteniendo los tests en verde y luego aterrizalo como un Conventional Commit atómico con scope explícito.
3. **Gestioná la complejidad.** Mantené los sistemas lo bastante entendibles como para cambiarlos con seguridad.
4. **Usá evidencia.** Preferí tests, output de CI, observaciones de runtime y artifacts preservados por encima de moda, autoridad, intuición o consenso de IA.
5. **Juzgá por estabilidad y throughput.** Una práctica sirve cuando mejora calidad/confiabilidad/recuperación y/o delivery frecuente y eficiente sin dañar la otra dimensión.

## TDD como loop de feedback por defecto

Cuando el trabajo cambia comportamiento, preferí TDD como primer mecanismo de aprendizaje:

1. **Nombrá el comportamiento o riesgo que querés aprender.** ¿Qué incertidumbre estamos reduciendo?
2. **Red:** escribí o describí el test/check mínimo que falle y lo exponga. Para bugs, reproducí el bug. Para refactors, agregá characterization tests. Para comportamiento nuevo, especificá el resultado esperado en un test.
3. **Green:** hacé el cambio de implementación más pequeño que pase.
4. **Refactor:** mejorá nombres, límites, cohesión, coupling, duplicación y claridad mientras los tests siguen en verde.
5. **Verify:** corré los checks locales relevantes y la señal de CI; cuando se pueda, capturá el comando y el resultado exactos.
6. **Commit:** aterrizá el cambio como un commit atómico usando Conventional Commits con scope explícito (por ejemplo, `fix(pandi-goal): …`). Un solo cambio coherente por commit, con el test que fija el comportamiento en el SAME commit que el código que cubre.

Si TDD no es la herramienta correcta para la tarea, decí por qué y nombrá la evidencia de reemplazo: resultado de spike, señal de CI, observación de runtime, feedback de usuario, métrica u otro check ejecutable.

## Forma de respuesta requerida al usar este skill

Para planes, reviews o guía de implementación, incluí estos puntos salvo que sean claramente irrelevantes:

- **Objetivo de aprendizaje:** la incertidumbre o el riesgo que se está probando.
- **Paso más chico y seguro:** el recorte reversible más angosto.
- **Plan de TDD/feedback:** el test o check que debería fallar primero, o la evidencia de reemplazo explícita.
- **Chequeo de complejidad:** impacto en modularidad, cohesión, separación de responsabilidades, encapsulamiento de información, abstracción y acoplamiento.
- **Chequeo de estabilidad/throughput:** efecto esperado sobre confiabilidad, recuperación, velocidad de delivery y seguridad del cambio.
- **Condición de stop:** qué evidencia alcanza para seguir, frenar o revertir.

## Cómo aplicarlo

Al ayudar con un diseño, review, plan, implementación o dynamic workflow:

1. **Expresá el objetivo de aprendizaje como una hipótesis testeable.** ¿Qué observación la refutaría?
2. **Elegí el recorte útil más chico.** Preferí un incremento reversible, un spike o un workflow angosto antes que una reescritura amplia.
3. **Empezá con TDD si cambia comportamiento.** Nombrá el test fallido, fixture, golden output, smoke check, señal de CI o medición que va a probar o refutar la hipótesis.
4. **Mantené incrementos chicos y reversibles.** Evitá reescrituras grandes y especulativas salvo que la evidencia medida las exija.
5. **Reducí complejidad de forma deliberada.** Revisá modularidad, cohesión, separación de responsabilidades, encapsulamiento de información, límites de abstracción y acoplamiento durante el paso de Refactor, no como diseño especulativo.
6. **Evaluá estabilidad y throughput.** Explicá el impacto esperado en calidad, confiabilidad, recuperación, frecuencia de deploy y eficiencia de delivery.
7. **Reportá evidencia, no confianza.** Cerrá con comandos, resultados de tests/CI, señales observadas o incertidumbre explícita.

**Cierre:** antes de continuar o entregar, vinculá la hipótesis, el recorte reversible, el feedback elegido y el impacto esperado con la evidencia observada; declaralos como motivo para seguir, frenar o revertir.

## Checklist de review

Usá estas preguntas en code review, design review y plan review:

- **TDD:** ¿Qué test fallido, characterization test o check ejecutable impulsó este cambio? Si no hubo ninguno, ¿la excepción está justificada y qué evidencia lo reemplazó?
- **Aprendizaje:** ¿Qué probó o refutó este cambio? ¿Acorta o demora el feedback?
- **Incrementalidad:** ¿Puede entregarse o validarse en un recorte reversible más chico?
- **Calidad de tests:** ¿Los tests son rápidos, deterministas, significativos, enfocados en comportamiento, mantenibles y aptos para CI?
- **Nivel de test:** ¿El comportamiento está testeado en el nivel útil más barato, con cobertura de integración/aceptación para riesgos entre límites?
- **Deployability:** ¿Preserva caminos seguros de release, rollback y recovery?
- **Modularidad:** ¿Las responsabilidades están aisladas detrás de interfaces claras?
- **Cohesión:** ¿Las piezas que cambian juntas viven juntas?
- **Coupling:** ¿Esto introduce dependencias que encarecen cambios futuros?
- **Information hiding:** ¿Los detalles internos quedan ocultos o los callers necesitan saber demasiado?
- **Estabilidad:** ¿Qué modos de falla, señales de confiabilidad o caminos de recovery cambiaron?
- **Throughput:** ¿Esto hará que futuros cambios sean más rápidos, más lentos o más seguros?
- **Evidencia:** ¿Las afirmaciones están respaldadas por tests, comandos, métricas, logs, artifacts o evidencia concreta en el código?

## Guía para dynamic workflows

Para Pi Dynamic Workflows en particular:

- Usá workflows para acortar loops de aprendizaje cuando el trabajo sea amplio, incierto o se beneficie de perspectivas realmente independientes.
- Empezá el diseño del workflow desde el loop de test/feedback: ¿qué check ejecutable o artifact decidirá si el workflow tuvo éxito?
- Mantené ramas de workflow independientes, chicas y productoras de evidencia. Cada rama debería devolver artifacts concretos, no solo opiniones.
- Persistí artifacts para que el aprendizaje sobreviva a la compactación del chat: output de tests, casos fallidos, pasos de reproducción, decisiones sintetizadas, alternativas descartadas y riesgos no resueltos.
- Agregá synthesis-as-judge y review adversarial cuando la corrección importe, pero exigí tests ejecutables o evidencia concreta antes de aceptar conclusiones.
- Mantené los workflows generados chicos y específicos de la tarea hasta que evidencia repetida muestre valor reutilizable.
- Tratá `maxAgents`, concurrency, elección de modelo, condiciones de stop y paths de artifacts como controles de ingeniería. Definilos desde el objetivo de aprendizaje, costo, riesgo y estrategia de verificación en lugar de copiar defaults.
- Preferí un workflow chico más un check rápido antes que una orquestación grande que demore el feedback u oculte la responsabilidad.

## Anti-patrones a señalar

- Implementar comportamiento antes de especificar el test fallido o check ejecutable.
- Tratar TDD como opcional cuando la tarea cambia comportamiento sin nombrar evidencia de reemplazo.
- Reescrituras grandes y especulativas que postergan el aprendizaje.
- Abstracciones, configurabilidad o proceso agregados sin evidencia de que mejoren estabilidad, throughput o control de complejidad.
- Tests lentos, flaky o demasiado integrados usados donde servirían tests rápidos y enfocados.
- Consenso entre agentes, síntesis o código generado por IA tratados como equivalentes a tests que pasan.
- Afirmaciones de éxito sin comandos, resultados de CI, evidencia de review, métricas o comportamiento observable.

## Guardrails

- No agregues burocracia, ceremonias, abstracciones ni configurabilidad salvo que mejoren aprendizaje, estabilidad, throughput o control de complejidad.
- No optimices velocidad local salteando tests o evidencia.
- No confundas output generado por IA con corrección; exigí review y verificación.
- Si el mejor próximo paso es un test chico, un spike o una medición, preferilo antes que un gran diseño.
