# Resumen de ingeniería de software moderna según Dave Farley

Investigación fuente:

- `docs/research/2026-06-25-dave-farley-modern-software-engineering.md`
- InformIT/Pearson: _Modern Software Engineering: Doing What Works to Build Better Software Faster_
- Capítulo de muestra de InformIT/Pearson “Software Engineering Fundamentals”
- Dave Farley: “What is Modern Software Engineering?”

## Tesis

La ingeniería de software moderna no es un proceso más pesado. Es el uso disciplinado de pensamiento científico, empírico y pragmático para construir mejor software más rápido.

## Dos competencias centrales

1. **Aprendizaje:** el desarrollo de software es descubrimiento y diseño. Trabajá de forma iterativa e incremental, buscá feedback rápido y de alta calidad, formulá hipótesis, medí resultados y decidí a partir de evidencia.
2. **Gestión de la complejidad:** los sistemas reales no entran en la cabeza de una sola persona. Usá principios de diseño que mantengan los sistemas comprensibles y cambiables.

## Principios de diseño para manejar la complejidad

- **Modularidad:** dividí el sistema en partes comprensibles y modificables.
- **Alta cohesión:** mantené juntas las cosas que cambian por la misma razón.
- **Separación de responsabilidades:** aislá responsabilidades distintas.
- **Ocultamiento de información y abstracción:** exponé interfaces simples y ocultá los detalles internos.
- **Bajo acoplamiento:** reducí dependencias que vuelven costoso el cambio.

## Criterios de evaluación

La vara útil de Farley se alinea con _Accelerate_:

- **Stability:** calidad, confiabilidad, baja tasa de fallos y recuperación rápida.
- **Throughput:** entrega frecuente y eficiente de cambios.

Adoptá una práctica, herramienta o proceso cuando mejore una de estas dimensiones sin dañar materialmente la otra.

## Prácticas al servicio de los principios

- automated testing
- TDD
- continuous integration
- continuous delivery
- deployability
- testability
- cambios pequeños
- pipelines rápidos

## TDD como aprendizaje ejecutable

En este skill, TDD se trata como el loop concreto por defecto para trabajo que cambia comportamiento, porque convierte el aprendizaje en feedback ejecutable:

1. **Red:** capturá el comportamiento deseado, bug o characterization como un test/check que falle.
2. **Green:** hacé el cambio más pequeño que pase.
3. **Refactor:** mejorá el diseño mientras preservás tests en verde.

TDD no debería volverse ceremonia. Si el trabajo es solo de docs, investigación exploratoria, un spike descartable o diagnóstico de runtime/operaciones, usá otro loop rápido de evidencia y decláralo explícitamente.

## Preguntas prácticas para aplicar

Ante cualquier cambio propuesto, preguntate:

1. ¿Qué estamos tratando de aprender?
2. ¿Cuál es el paso seguro más pequeño?
3. ¿Qué feedback lo va a probar o refutar?
4. ¿Esto reduce o aumenta la complejidad?
5. ¿Cuál es el efecto sobre `Stability` y `Throughput`?
