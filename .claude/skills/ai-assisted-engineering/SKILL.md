---
name: ai-assisted-engineering
description:
  Decidí cómo delegar a IA o agentes cuando el trabajo requiera fijar autonomía, distinguir prototipo de producción,
  programar prompts/context/tools o evaluar un output generado.
---

# Ingeniería asistida por IA

## En 30 segundos

- **Qué es:** criterio para aprovechar IA/agentes manteniendo especificación, evaluación y ownership humanos.
- **Problema:** generar más rápido no demuestra que el resultado sea correcto, seguro ni entendible.

Tratá cada output generado como una hipótesis. Para fundamentos y fuentes, consultá
`references/karpathy-programming-recommendations.md`.

## Proceso

| Paso                     | Acción                                                                                                                                            | Cierre                                                                                      |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| 1. Clasificar            | Nombrá el contexto como **prototype/exploration** o **production/shared/risky**. Ajustá el rigor al impacto y al blast radius.                    | El nivel de riesgo y la evidencia exigida quedaron explícitos.                              |
| 2. Delimitar             | Separá qué puede generar, explorar o ejecutar la IA de lo que la persona debe especificar, revisar y aprobar.                                     | Cada decisión irreversible o de corrección tiene ownership humano identificado.             |
| 3. Recortar              | Elegí la rebanada más chica, legible e inspeccionable que permita aprender. Empezá por cheap scout y simple baseline antes de ampliar.            | El incremento puede explicarse, revisarse y revertirse sin depender de magia oculta.        |
| 4. Programar el contexto | Definí prompt, evidencia esperada, tools y permisos, formato de salida y condiciones de stop. Fenceá datos no confiables.                         | El contrato de ejecución es visible y no depende de supuestos implícitos.                   |
| 5. Verificar             | Elegí tests, evals, reproducción, diff review o checks externos que puedan refutar el resultado. El consenso entre agentes no cuenta como prueba. | Existe evidencia ejecutable suficiente o el resultado queda marcado como no verificado.     |
| 6. Escalar o frenar      | Mostrá fallas parciales, caps y ramas omitidas. Escalá a una persona cuando la evidencia, permisos o alcance excedan el contrato.                 | La condición para avanzar, volver atrás o pedir intervención quedó satisfecha y registrada. |

Para dynamic workflows, hacé visible el patrón agéntico, fijá `model`, `effort`, concurrency y caps según el riesgo,
separá `explore/generate` de `verify/commit` y registrá toda reducción de cobertura.

## Contrato de salida

Incluí solo los campos aplicables, sin inventar contenido para completar la forma:

- **Nivel de riesgo:** prototype/exploration o production/shared/risky.
- **Límite de delegación:** IA/agentes versus ownership humano.
- **Rebanada mínima:** incremento inspeccionable elegido.
- **Verificación:** evidencia ejecutable y resultado observado.
- **Escalamiento:** condición para avanzar, frenar o devolver control.

## Criterio de cierre

Terminá cuando el riesgo, la autonomía, la rebanada y la evidencia sean explícitos; las fallas parciales sigan visibles;
y una persona conserve la decisión final de corrección. Si falta evidencia, entregá el resultado como hipótesis
pendiente, no como éxito.

## Fronteras y deferencias

| Decisión                                                             | Skill responsable             |
| -------------------------------------------------------------------- | ----------------------------- |
| Si TDD es el loop de feedback adecuado y qué evidencia lo reemplaza  | `modern-software-engineering` |
| Step size, test list y tidy first/after/later/never                  | `empirical-software-design`   |
| Legibilidad, síntomas de diseño y dirección de dependencias          | `clean-craftsmanship`         |
| Cómo componer y ejecutar el workflow multiagente una vez justificado | `ultracode`                   |
