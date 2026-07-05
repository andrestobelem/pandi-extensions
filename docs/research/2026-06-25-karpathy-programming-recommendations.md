# Recomendaciones de Andrej Karpathy sobre programación, aprendizaje y uso de IA

Fecha: 2026-06-25

## En 30 segundos

Este informe recupera y aplica ideas de Karpathy sobre cómo programar, aprender y trabajar con IA. La lectura útil es simple: construir para entender, delegar con criterio y verificar siempre con evidencia.

## Objetivo

Recuperar y aplicar la investigación sobre los principios de programación de Andrej Karpathy a Dynamic Workflows, los prompts y la UX de agentes. El workflow histórico fue restaurado desde `HEAD` (`.pi/workflows/karpathy-programming-recommendations-research.js`), sintetizando fuentes primarias sobre aprendizaje, programación asistida por IA y juicio de ingeniería.

## Workflow recuperado

Restaurado desde `.pi/workflows/karpathy-programming-recommendations-research.js`.

**Enfoque de investigación:** fan-out por ángulos (fuentes primarias, aprendizaje de programación/ML, programación asistida por IA, principios de ingeniería, verificación escéptica) y síntesis con evidencia, citas, confianza y aplicabilidad.

## Fuentes principales

- [Andrej Karpathy homepage](https://karpathy.ai/)
- [Sequoia Ascent 2026 summary: Software 3.0 & agentic engineering](https://karpathy.bearblog.dev/sequoia-ascent-2026/)
- [Vibe coding MenuGen](https://karpathy.bearblog.dev/vibe-coding-menugen/)
- [Software 2.0](https://karpathy.medium.com/software-2-0-a64152b37c35)
- [A Recipe for Training Neural Networks](https://karpathy.github.io/2019/04/25/recipe/)
- Repositorios [micrograd](https://github.com/karpathy/micrograd) y [nanoGPT](https://github.com/karpathy/nanoGPT)
- [Empirical cross-check on vibe coding](https://arxiv.org/abs/2506.23253)

## Síntesis práctica

### 1. Aprender construyendo desde cero

**Principio:** las implementaciones pequeñas, legibles y completas revelan los fundamentos.

**Evidencia:** `micrograd`, `nanoGPT`, Zero to Hero y material educativo en karpathy.ai.

**Aplicación:** los ejemplos y workflows de Pi deben poder inspeccionarse, modificarse y evitar la magia oculta.

### 2. Entender antes de delegar

**Principio:** la IA reduce fricción, pero no reemplaza el juicio técnico en sistemas importantes.

**Evidencia:** textos sobre vibe coding y Software 3.0; MenuGen documenta fricciones reales en auth, payments, deploy, API y reliability.

**Aplicación:** usar agentes para acelerar, pero conservar revisión humana, tests y evidencia.

### 3. Software 3.0: programar con prompts, contexto y tools

**Principio:** evolución de Software 1.0 (código explícito) → Software 2.0 (pesos aprendidos) → Software 3.0 (LLMs programados mediante prompts, contexto, ejemplos, memoria y tools).

**Aplicación:** en Dynamic Workflows, los prompts, artifacts, schemas, scoped tools y dashboards forman parte de la interfaz de programación, no son detalles secundarios.

### 4. Vibe coding para prototipos, no para producción

**Principio:** sirve para apps personales, demos y exploración rápida. Producción requiere specs, review, tests/evals, seguridad y responsabilidad humana.

**Aplicación:** separar `explore/generate` de `verify/commit`; hacer visible qué quedó validado.

### 5. Debugging incremental y baselines simples

**Principio:** inspeccionar datos, empezar simple, verificar supuestos, overfit casos pequeños y sumar complejidad gradualmente.

**Evidencia:** "A Recipe for Training Neural Networks".

**Aplicación:** los workflows complejos necesitan scouts baratos, caps visibles, smoke tests y artifacts antes de fan-outs grandes.

### 6. El rol del experto se desplaza hacia especificar, evaluar y depurar

**Principio:** el uso de IA mueve el trabajo desde escribir código hacia gestionar contexto, revisar salidas, diseñar tests y verificar corrección.

**Aplicación:** los dashboards y graphs deberían mostrar estado, agentes, evidencia y fallos parciales para que las personas puedan supervisar.

## Implicancias para este proyecto

- **Visualización de workflows:** mostrar no solo las llamadas, sino también el patrón agentic en uso (fan-out, judge, feedback, pipeline, routing).
- **Prompts como programas:** dejar legibles los evidence contracts, los allowed tools, los output formats y las stop conditions.
- **Ejemplos:** preferir implementaciones pequeñas y educativas (estilo `micrograd`/`nanoGPT`) que sean fáciles de leer y ejecutar.
- **Verificación:** para tareas serias, usar synthesis-as-judge, tests o verificación externa; nunca tratar la salida de un agente como verdad sin evidencia.

## Validación

```bash
node --check .pi/workflows/karpathy-programming-recommendations-research.js
```

## Próximo paso

Actualizar el workflow restaurado a patrones de runtime (`settle:true`, `agentType:"researcher"`, logging de partial-failure y explicit concurrency) sin perder su contrato con fuentes primarias.
