---
name: clean-craftsmanship
description:
  Aplicá clean craftsmanship al escribir o revisar código por legibilidad, diagnosticar rigidez, fragilidad, inmovilidad
  o viscosidad, revisar la Dependency Rule y justificar límites o abstracciones. Usá también para estimaciones,
  compromisos y limpieza profesional bajo presión.
---

# Clean craftsmanship

## En 30 segundos

- **Qué es:** oficio a nivel de código, diagnóstico de diseño, dirección de dependencias y conducta profesional.
- **Problema:** desorden, abstracciones gratuitas y dependencias mal gestionadas encarecen cada cambio futuro.

Diagnosticá antes de prescribir principios. Para fundamentos, salvedades y fuentes, consultá
`references/uncle-bob-clean-craftsmanship.md`.

## Proceso

| Paso                          | Acción                                                                                                                                                                                                    | Cierre                                                                                             |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 1. Leer intención             | Seguí el código de arriba hacia abajo. Revisá nombres, tamaño y foco de funciones, niveles de abstracción, argumentos, efectos secundarios y separación comando–consulta.                                 | Cada problema de legibilidad está ligado a una evidencia concreta, no a una preferencia estética.  |
| 2. Diagnosticar               | Buscá **rigidez**, **fragilidad**, **inmovilidad** y **viscosidad**. Rastreá cada síntoma hasta una dependencia o restricción observable.                                                                 | Todo síntoma reclamado tiene archivo/línea, consecuencia y dependencia causante.                   |
| 3. Revisar límites            | Comprobá que las dependencias de código fuente apunten hacia adentro. Exigí que cada interfaz o capa pague su renta mediante una segunda implementación, un adaptador volátil o complejidad de dominio.   | La dirección y la utilidad de cada límite tocado están justificadas o se recomienda simplificarlo. |
| 4. Elegir disciplina          | Aplicá SOLID o principios de componentes solo al síntoma observado. Mantené la Boy Scout rule dentro del radio del cambio y condicioná refactors por IA a una suite previamente en verde y review humano. | La solución responde al diagnóstico sin layering ni limpieza especulativa.                         |
| 5. Comunicar profesionalmente | Separá estimaciones con incertidumbre de compromisos explícitos. Ante un pedido imposible, decí que no y ofrecé alternativas verificables.                                                                | El alcance, la incertidumbre y cualquier compromiso quedaron expresados sin promesas encubiertas.  |
| 6. Verificar                  | Preferí tests de arquitectura, linters de dependencias y suites verdes a opiniones. Considerá el costo de indirection o CPU en código crítico de performance.                                             | La recomendación tiene evidencia repetible y sus costos relevantes están visibles.                 |

Las tres leyes de TDD funcionan aquí como disciplina dentro de un loop ya elegido: test que falla, solo el test
suficiente para fallar y solo el código de producción suficiente para pasar. La decisión de usar TDD pertenece a
`modern-software-engineering`.

## Contrato de salida

Incluí solo los campos aplicables:

- **Legibilidad:** regla afectada y evidencia concreta.
- **Síntoma:** rigidez, fragilidad, inmovilidad o viscosidad, con causa.
- **Dependencias:** dirección observada y cualquier violación.
- **Renta del límite:** fuerza que justifica una interfaz/capa o recomendación de eliminarla.
- **Compromiso:** estimación con incertidumbre o compromiso explícito.
- **Limpieza:** Boy Scout dentro del alcance o deferencia del tidy mayor.

## Criterio de cierre

Terminá cuando cada hallazgo aplicable tenga evidencia, los límites tocados tengan dirección y renta explícitas, la
solución no exceda el diagnóstico y la limpieza o el compromiso estén acotados honestamente. En código crítico de
performance, dejá visible el costo de las abstracciones recomendadas.

## Fronteras y deferencias

| Decisión                                                   | Skill responsable             |
| ---------------------------------------------------------- | ----------------------------- |
| Si TDD es el loop de feedback y qué evidencia lo reemplaza | `modern-software-engineering` |
| Step size y tidy first/after/later/never                   | `empirical-software-design`   |
| Delegación a IA y ownership humano                         | `ai-assisted-engineering`     |
| Composición y ejecución de dynamic workflows               | `ultracode`                   |
