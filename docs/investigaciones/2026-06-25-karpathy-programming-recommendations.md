# Recomendaciones de Andrej Karpathy para programar, aprender y usar IA

Fecha: 2026-06-25

## Objetivo

Recuperar e integrar el bloque de investigación sobre Andrej Karpathy que había quedado referenciado pero no disponible en el repo. Se restauró el workflow histórico y se dejó una síntesis accionable para usar como criterio en Dynamic Workflows, prompts y UX de agentes.

## Workflow recuperado

- Restaurado desde `HEAD`:
  - `.pi/workflows/karpathy-programming-recommendations-research.js`
- Propósito del workflow:
  - Investigar con fan-out por ángulos: fuentes primarias, aprender a programar/ML, AI-assisted coding, principios de ingeniería y verificación escéptica.
  - Sintetizar en español con formato: recomendación, evidencia primaria, cita/paráfrasis, confianza y aplicabilidad.

## Fuentes principales identificadas

- Andrej Karpathy homepage: https://karpathy.ai/
- Sequoia Ascent 2026 summary / Software 3.0 / agentic engineering: https://karpathy.bearblog.dev/sequoia-ascent-2026/
- Vibe coding MenuGen: https://karpathy.bearblog.dev/vibe-coding-menugen/
- Software 2.0: https://karpathy.medium.com/software-2-0-a64152b37c35
- A Recipe for Training Neural Networks: https://karpathy.github.io/2019/04/25/recipe/
- micrograd: https://github.com/karpathy/micrograd
- nanoGPT: https://github.com/karpathy/nanoGPT
- Cross-check empírico sobre vibe coding: https://arxiv.org/abs/2506.23253

## Síntesis práctica

1. **Aprender construyendo desde cero**
   - Karpathy suele favorecer implementaciones pequeñas, legibles y completas para entender fundamentos.
   - Evidencia: `micrograd`, `nanoGPT`, Zero to Hero y su material educativo indexado desde `karpathy.ai`.
   - Aplicación en Pi: ejemplos/workflows deben ser pequeños, inspeccionables y modificables; evitar magia oculta.

2. **Entender antes de delegar**
   - La IA baja la fricción para crear, pero no reemplaza criterio técnico cuando el sistema importa.
   - Evidencia: posts sobre vibe coding y Software 3.0; en MenuGen documenta fricciones reales de auth, pagos, deploy, API y confiabilidad.
   - Aplicación en Pi: usar agentes para acelerar, pero conservar revisión humana, tests y evidencia.

3. **Software 3.0: programar con prompts/contexto/herramientas**
   - Karpathy enmarca una evolución: Software 1.0 = código explícito, Software 2.0 = pesos aprendidos, Software 3.0 = LLMs programados vía prompts, contexto, ejemplos, memoria y tools.
   - Aplicación en Dynamic Workflows: prompts, artifacts, schemas, tools scoped y dashboard son parte de la interfaz de programación, no detalles secundarios.

4. **Vibe coding sirve muy bien para prototipos, no como garantía de producción**
   - Útil para apps personales, demos y exploración rápida.
   - Para producción hacen falta especificaciones, permisos, revisión de diffs, tests/evals, seguridad y ownership humano.
   - Aplicación en Pi: separar “explorar/generar” de “verificar/commit”; hacer visible qué fue validado.

5. **Debugging incremental y baselines simples**
   - En “A Recipe for Training Neural Networks” recomienda inspeccionar datos, empezar simple, verificar supuestos, overfit de casos pequeños y agregar complejidad gradualmente.
   - Aplicación en Pi: workflows complejos deberían tener scout barato, caps visibles, smoke tests y artifacts antes de fan-outs grandes.

6. **El rol del experto cambia hacia especificar, evaluar y depurar**
   - El uso de IA desplaza parte del trabajo de escribir código a gestionar contexto, revisar salidas, diseñar pruebas y decidir si algo es correcto.
   - Aplicación en Pi: dashboard/graph deben mostrar estado, agentes, evidencia y fallas parciales para que el humano pueda supervisar.

## Implicancias para este proyecto

- La visualización de workflows tiene que mostrar no solo “qué llamada ocurrió”, sino qué patrón de programación agéntica se está usando: fan-out, judge, feedback, pipeline, routing.
- Los prompts deben funcionar como “programas” legibles: contrato de evidencia, herramientas permitidas, formato de salida y stop conditions.
- Los ejemplos deben favorecer implementaciones pequeñas y educativas, en línea con `micrograd`/`nanoGPT`: fáciles de leer y correr.
- Para tareas serias, nunca tratar una salida de agente como verdad sin síntesis-as-judge, pruebas o verificación externa.

## Validación

```bash
node --check .pi/workflows/karpathy-programming-recommendations-research.js
```

## Próximo paso opcional

Actualizar el workflow restaurado a los patrones más nuevos del runtime (`settle:true`, `agentType:"researcher"`, logging de fallas parciales y concurrencia dinámica más explícita) sin perder su contrato original de fuentes primarias.
