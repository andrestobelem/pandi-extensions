---
name: empirical-software-design
description:
  Aplicá diseño empírico al conducir el micro-ritmo de un loop TDD o al supervisar un agente implementador dentro de
  ese loop.
---

# Diseño empírico de software

## En 30 segundos

- **Qué es:** micro-ritmo de TDD y economía local del diseño al estilo Kent Beck.
- **Problema:** pasos grandes, generalización prematura o tidy mezclado con comportamiento encarecen feedback y
  reversión.

El step size es una perilla: achicalo ante sorpresas y agrandalo con evidencia. Para fundamentos, catálogo de tidyings y
fuentes, consultá `references/kent-beck-empirical-software-design.md`.

## Proceso

| Paso                        | Acción                                                                                                                                                                   | Cierre                                                                            |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| 1. Clasificar               | Separá **comportamiento** de **estructura**. Mantené un solo tipo por paso y, cuando sea posible, por commit o PR.                                                       | El cambio actual tiene una categoría inequívoca y una razón para su timing.       |
| 2. Preparar                 | Para comportamiento, escribí una test list y elegí exactamente un ítem. Para estructura, nombrá el cambio futuro que el tidying abarata.                                 | Hay un objetivo único y observable; el resto permanece pendiente.                 |
| 3. Ir a Red                 | Convertí el ítem elegido en un test concreto que falle por la razón esperada.                                                                                            | El Red reproduce la ausencia de comportamiento sin fallas incidentales.           |
| 4. Llegar a Green           | Elegí **Obvious Implementation**, **Fake It** o **Triangulate**. Escribí solo lo necesario para Green y bajá de gear si el resultado sorprende.                          | Todos los tests pasan y ninguna generalización excede la evidencia disponible.    |
| 5. Decidir el tidy          | Elegí **first**, **after**, **later** o **never** con criterio económico. Aplicá las four rules: tests verdes; intención y no duplicación; mínima cantidad de elementos. | El timing está justificado y el tidy preserva comportamiento.                     |
| 6. Preservar reversibilidad | Mantené el diff chico, verificable y separable. Detectá tests lentos, ambiguos, acoplados a implementación o de baja fidelidad antes de exigir el micro-ritmo.           | El paso es barato de revisar/revertir o la degradation condition quedó explícita. |

Para agentes implementadores, fijá como hard stops los tests o assertions borrados, fake implementations, loops y scope
no pedido. En fase **Explore**, preferí experimentos chicos y no correlacionados; en **Expand**, el próximo bottleneck;
en **Extract**, confiabilidad y repetibilidad.

## Contrato de salida

Incluí solo los campos aplicables:

- **Clasificación:** estructura o comportamiento.
- **Test list:** ítem activo y pendientes relevantes.
- **Gear:** Obvious Implementation, Fake It o Triangulate, con motivo.
- **Tidy timing:** first/after/later/never y razón económica.
- **Simplicidad:** resultado de las four rules.
- **Reversibilidad:** checks, tamaño del paso y degradation conditions.

## Criterio de cierre

Terminá cuando el paso tenga una sola categoría, el feedback haya llegado de Red a Green, el gear y el tidy timing sean
explícitos y el diff siga siendo barato de revisar y revertir. Si una degradation condition impide ese ritmo, priorizá
reparar el feedback y reportá el bloqueo.

## Fronteras y deferencias

| Decisión                                                       | Skill responsable             |
| -------------------------------------------------------------- | ----------------------------- |
| Si TDD aplica y qué evidencia puede reemplazarlo               | `modern-software-engineering` |
| Cuánto delegar a IA y si el contexto es prototype o production | `ai-assisted-engineering`     |
| Legibilidad, síntomas de diseño, SOLID y Dependency Rule       | `clean-craftsmanship`         |
| Composición y ejecución de dynamic workflows                   | `ultracode`                   |
