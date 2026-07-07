# Andrej Karpathy — programar, aprender y usar IA (resumen compacto de fuentes)

Fuente destilada para la skill `ai-assisted-engineering`.
Investigación más completa del proyecto:
`docs/research/2026-06-25-karpathy-programming-recommendations.md`.

## Fuentes primarias

- Sitio personal: https://karpathy.ai/
- Sequoia Ascent 2026 / Software 3.0 / ingeniería agéntica: https://karpathy.bearblog.dev/sequoia-ascent-2026/
- Vibe coding MenuGen: https://karpathy.bearblog.dev/vibe-coding-menugen/
- Software 2.0: https://karpathy.medium.com/software-2-0-a64152b37c35
- A Recipe for Training Neural Networks: https://karpathy.github.io/2019/04/25/recipe/
- micrograd: https://github.com/karpathy/micrograd
- nanoGPT: https://github.com/karpathy/nanoGPT
- Contraste empírico sobre vibe coding: https://arxiv.org/abs/2506.23253

## Síntesis práctica

1. **Aprender construyendo desde cero.** Implementaciones pequeñas, legibles y completas para entender los fundamentos; evitar la magia oculta (`micrograd`, `nanoGPT`, Zero to Hero).
2. **Entender antes de delegar.** La IA baja la fricción de crear, pero no reemplaza el juicio técnico cuando el sistema importa (`vibe-coding MenuGen` documenta fricciones reales: auth, payments, deploy, API, reliability).
3. **Software 3.0.** Software 1.0 = código explícito; 2.0 = pesos aprendidos; 3.0 = LLMs programados con prompts, contexto, ejemplos, memoria y herramientas. Todo eso es parte de la interfaz de programación, no un detalle secundario.
4. **`vibe coding` ≠ garantía de producción.** Sirve muy bien para prototipos, demos, apps personales y exploración rápida. Producción exige especificaciones, permisos, revisión de diffs, tests/evals, seguridad y responsabilidad humana. Separar explore/generate de verify/commit.
5. **Depuración incremental y baselines simples.** Inspeccionar los datos, empezar simple, verificar supuestos, sobreajustar un caso chico y agregar complejidad de a poco (`A Recipe for Training Neural Networks`).
6. **El rol de la persona experta cambia** hacia especificar, evaluar y debuggear: gestionar contexto, revisar salidas, diseñar tests y decidir si algo es correcto.

## Implicancias para este proyecto

- Visualizar *qué patrón agéntico* está en uso (`fan-out`, `judge`, `feedback`, `pipeline`, `routing`), no solo qué llamada ocurrió.
- Los prompts son “programas” legibles: evidence contract, herramientas permitidas, formato de salida y stop conditions.
- Favorecer ejemplos chicos, didácticos y ejecutables (`micrograd`/`nanoGPT`).
- En tareas serias, nunca tratar la salida de un agente como verdad sin `synthesis-as-judge`, tests o verificación externa.
