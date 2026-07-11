---
name: modern-software-engineering
description:
  Aplicá ingeniería de software moderna al diseñar arquitectura, planear refactors, revisar código, definir una
  estrategia de tests o mejorar delivery mediante feedback ejecutable.
---

# Ingeniería de software moderna

## En 30 segundos

- **Qué es:** ingeniería como aprendizaje disciplinado mediante feedback ejecutable.
- **Problema:** cambios grandes o sin hipótesis postergan la evidencia y acumulan complejidad.

Tratá cada cambio como una hipótesis refutable. Para fundamentos y fuentes, consultá
`references/dave-farley-modern-software-engineering.md`.

## Proceso

| Paso                     | Acción                                                                                                                                                                                                                   | Cierre                                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| 1. Formular              | Expresá el objetivo de aprendizaje y la observación que refutaría la propuesta.                                                                                                                                          | La hipótesis distingue claramente éxito, falla e incertidumbre.                            |
| 2. Recortar              | Elegí el incremento útil más chico que sea seguro, reversible y entregable.                                                                                                                                              | El paso reduce una incertidumbre concreta sin una reescritura especulativa.                |
| 3. Diseñar feedback      | Para comportamiento, usá **Red → Green → Refactor**: test o reproducción en rojo, implementación mínima en verde y pasada explícita de refactor. Si TDD no aplica, nombrá la evidencia equivalente antes de implementar. | El check falla por la razón esperada o la evidencia sustituta está definida y justificada. |
| 4. Gestionar complejidad | Durante Refactor, revisá modularidad, cohesión, separación de responsabilidades, information hiding, abstracción y coupling.                                                                                             | La complejidad accidental disminuye o queda aceptada con una razón observable.             |
| 5. Evaluar delivery      | Estimá el efecto sobre confiabilidad, recovery, frecuencia y seguridad de entrega.                                                                                                                                       | El cambio no mejora throughput ocultando un costo de estabilidad, ni al revés.             |
| 6. Verificar             | Corré los checks relevantes, preservá comandos/resultados y comparalos con la hipótesis.                                                                                                                                 | La evidencia permite avanzar, frenar o revertir sin depender de confianza declarada.       |

En dynamic workflows, diseñá primero el check que juzga la corrida; exigí artifacts concretos por rama; preservá fallas
y cobertura; y agregá review adversarial solo cuando aumente la calidad del feedback.

## Contrato de salida

Incluí solo los campos aplicables:

- **Objetivo de aprendizaje:** hipótesis y señal que la refutaría.
- **Paso más chico:** incremento reversible elegido.
- **Feedback:** Red inicial o evidencia equivalente, más resultado observado.
- **Complejidad:** efecto sobre cohesión, límites, information hiding y coupling.
- **Estabilidad/throughput:** trade-off esperado y observado.
- **Condición de stop:** evidencia para seguir, frenar o revertir.

## Criterio de cierre

Terminá cuando la hipótesis, el recorte y el feedback estén vinculados con evidencia observada; la pasada de Refactor
haya ocurrido y su resultado esté narrado, incluso si no había nada que cambiar; y el efecto sobre estabilidad y
throughput sea explícito. Sin esa evidencia, reportá aprendizaje pendiente.

## Fronteras y deferencias

| Decisión                                                          | Skill responsable           |
| ----------------------------------------------------------------- | --------------------------- |
| Cuánto delegar a IA y qué ownership conserva la persona           | `ai-assisted-engineering`   |
| Test list, step size y tidy first/after/later/never dentro de TDD | `empirical-software-design` |
| Legibilidad, SOLID con síntomas y Dependency Rule                 | `clean-craftsmanship`       |
| Composición y ejecución del workflow multiagente                  | `ultracode`                 |
