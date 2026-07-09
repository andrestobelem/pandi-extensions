---
name: ai-assisted-engineering
description: >-
  Aplicá criterio al estilo Andrej Karpathy cuando construyas software con IA o
  agentes: construí cosas pequeñas para entender, separá prototipado/vibe-coding
  de producción, tratá prompts/context/tools como el programa (Software 3.0),
  depurá de forma incremental desde baselines simples y mantené a la persona
  humana como especificadora, evaluadora y dueña de la corrección. Usar cuando
  haya que decidir cuánto delegar a la IA, si un output es confiable o cómo
  diseñar workflows agénticos/dynamic workflows.
---

# Ingeniería asistida por IA

Usá este skill cuando una tarea implique **usar IA o agentes para construir software** y la pregunta de fondo sea de criterio: cuánto delegar, cuándo confiar en un output generado, cuándo conviene prototipar con libertad y cuándo verificar, y cómo diseñar agentic/dynamic workflows sin sacar a la persona del control.

Se apoya en la investigación del proyecto destilada desde las recomendaciones de Andrej Karpathy sobre programación, aprendizaje y uso de IA (Software 2.0/3.0, vibe coding, "A Recipe for Training Neural Networks", micrograd/nanoGPT). Ver `references/karpathy-programming-recommendations.md` para el resumen compacto de la fuente.

Es el complemento, en la era de la IA, del skill `modern-software-engineering`: ese aporta la disciplina de TDD/feedback/complejidad; este aporta la disciplina sobre *dónde encaja la IA dentro de eso*.

## Enfoque central

1. **Construí cosas pequeñas desde cero para entender.** Preferí implementaciones pequeñas, legibles y completas antes que magia oculta. Entender el sistema es el activo; el código es el medio para lograrlo (micrograd, nanoGPT, Zero to Hero).
2. **Entendé antes de delegar.** La IA baja la fricción de *crear*; no reemplaza el juicio técnico cuando el sistema importa. Usá agentes para acelerar, nunca para saltear review, tests o evidencia.
3. **Software 3.0: prompts/context/tools son el programa.** Los LLMs se programan con prompts, ejemplos, memoria, contexto y tools acotadas. Tratá eso como artifacts de ingeniería de primera clase — diseñados, versionados e inspeccionables — no como detalles descartables.
4. **Hacé vibe-code en prototipos; no en producción.** La generación libre es excelente para demos, apps personales y exploración rápida. Producción necesita specifications, permissions, diff review, tests/evals, security y una persona dueña. Separá "explore/generate" de "verify/commit" y hacé visible qué fue realmente validado.
5. **Depurá de forma incremental desde baselines simples.** Inspeccioná datos/inputs, empezá simple, verificá supuestos, sobreajustá un caso mínimo y recién después agregá complejidad. Hacé cheap scout y smoke test antes de cualquier fan-out grande.
6. **El rol de la persona experta se desplaza hacia especificar, evaluar y depurar.** A medida que la IA escribe más código, el trabajo humano se mueve hacia gestionar contexto, revisar outputs, diseñar tests/evals y *decidir si algo es correcto*.

## Forma de respuesta requerida al usar este skill

En un plan, review o implementación que se apoye en IA/agentes, incluí esto salvo que sea claramente irrelevante:

- **Nivel de confianza:** ¿esto es prototipo/exploración (`vibe-coding` OK) o producción/serio (`specs` + verificación obligatorias)? Decilo explícitamente.
- **Límite de delegación:** qué hace la IA/agente versus qué especifica, revisa y posee la persona.
- **Rebanada mínima entendible:** el incremento más chico e inspeccionable; preferí una implementación pequeña y legible antes que una generación amplia.
- **Plan de verificación:** los tests, evals, diff review o check ejecutable que decide la corrección — *no* el consenso entre agentes.
- **Condición para frenar/escalar:** qué evidencia alcanza para avanzar y qué obliga a volver a meter a una persona en el loop.

## Cómo aplicarlo

1. **Clasificá primero el nivel de riesgo.** Prototype/demo/personal → optimizá por velocidad y aprendizaje; la generación está bien. Production/shared/risky → exigí specs, review, tests, security y ownership.
2. **Delegá para acelerar, no para abdicar.** Dejá que la IA redacte, busque, refactorice y explore; la persona conserva la spec, el review y la decisión de que algo es correcto.
3. **Diseñá el prompt/context como un programa.** Dale a cada agente un evidence contract, tools permitidas, output format/schema y stop conditions. Hacé explícito y acotado el contexto en vez de implícito y amplio.
4. **Construí la cosa más chica que se pueda entender.** Preferí una implementación pequeña y legible, que puedas inspeccionar y modificar, antes que una grande y opaca, aunque la IA pudiera generar la grande más rápido.
5. **Empezá simple y agregá complejidad con evidencia.** Cheap scout → simple baseline → verificar supuestos → sobreajustar un caso chico → expandir. Sumá caps, smoke tests y artifacts antes de fan-outs grandes.
6. **Verificá con evidencia ejecutable.** Tratá el output de IA/agentes como una hipótesis. Confirmalo con tests, evals, reproducción, diff review o checks externos antes de aceptarlo.
7. **Mantené supervisión humana visible.** Mostrá estado, agentes, evidencia y fallas parciales para que una persona pueda especificar, evaluar y depurar, no solo mirar pasar llamadas.

**Cierre:** antes de avanzar o entregar, dejá explícitos el nivel de riesgo, el límite de delegación humana, la rebanada mínima, la evidencia ejecutable y la condición de escalamiento. Omití solo los ejes irrelevantes y nombrá el motivo.

## Checklist para trabajo asistido por IA/agentes

- **Riesgo:** ¿esto es prototipo o producción? ¿El rigor coincide?
- **Responsabilidad:** ¿queda claro qué especifica, revisa y por qué responde la persona?
- **Entendimiento:** ¿podrías explicar y modificar este código, o es magia generada y opaca?
- **Tamaño:** ¿es la rebanada más chica e inspeccionable, o una generación especulativa y amplia?
- **Prompt como programa:** ¿los agentes tienen evidence contract, tools acotadas, output format y stop conditions?
- **Primero lo mínimo:** ¿hubo cheap scout / simple baseline antes del fan-out grande?
- **Verificación:** ¿qué check ejecutable (test, eval, reproducción, diff review) confirma la corrección, más allá de "the model said so"?
- **Falla parcial:** ¿las ramas fallidas/vacías/stale de agentes quedan visibles, o se esconden detrás de un resumen confiado?
- **Seguridad/permisos:** para cualquier cosa más seria que un juguete, ¿están cubiertos auth, secrets, permissions y blast radius?

## Guía para dynamic workflows

Para Pi Dynamic Workflows en particular:

- Hacé visible el **agentic pattern** (fan-out, judge, feedback, pipeline, routing), no solo "qué llamada ocurrió"; el patrón *es* el programa.
- Escribí prompts como programas legibles: evidence contract, tools permitidas, output format y stop conditions; dejá el contenido volátil por ítem para el final.
- Mantené workflows de ejemplo/generados pequeños, inspeccionables y modificables (espíritu micrograd/nanoGPT); evitá la magia oculta.
- Separá etapas de explore/generate de etapas de verify/commit; cuando la corrección importe, no dejes pasar una síntesis sin synthesis-as-judge, tests o verificación externa.
- Empezá workflows amplios con cheap scout y simple baseline; fijá `maxAgents`, concurrency, model y caps según stakes y el objetivo de aprendizaje, y registrá con `log()` todo lo que acotás.

## Anti-patrones que hay que señalar

- Mandar a producción un output vibe-coded sin specs, review, tests, evals, security ni una persona dueña.
- Tratar el consenso entre IA/agentes o el código generado como equivalente a un test que pasa.
- Generar código grande y opaco cuando una implementación pequeña y legible enseñaría más y sería más segura de cambiar.
- Saltar a un fan-out grande o a un pipeline complejo antes de hacer cheap scout y simple baseline.
- Dejar implícitos y sin versionar prompts, contexto y alcance de tools mientras se trata solo al código como "el programa".
- Esconder fallas parciales de agentes detrás de un resumen confiado.

## Guardrails

- Ajustá el rigor al nivel de riesgo: no impongas ceremonia de producción a un prototipo descartable y no hagas vibe-code en nada de lo que dependan personas o sistemas.
- Usá la IA para acortar loops, no para saltear entendimiento, review o verificación.
- No confundas fluidez generada con corrección; exigí evidencia ejecutable y ownership humano.
- Si el siguiente paso más barato es una implementación pequeña y legible, un simple baseline o un único test decisivo, preferilo antes que una generación grande o una orquestación compleja.
