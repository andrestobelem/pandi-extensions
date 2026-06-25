# Mejora de prompts para workflows dinámicos

Fecha: 2026-06-25

## Objetivo

Aplicar lo aprendido sobre patrones de workflows agénticos a los prompts usados por nuestros workflows dinámicos.

## Patrones aplicados

- **Fan-out independiente**: cada subagente recibe instrucciones para producir un resultado autocontenido, incluso si otros agentes fallan.
- **Contrato de evidencia**: se exige citar archivos/líneas, URLs, comandos observados o marcar `INSUFFICIENT_EVIDENCE` / `NO_FINDINGS`.
- **Formato fijo**: los prompts piden secciones repetibles como veredicto, hallazgos, evidencia, riesgos, fix y verificación.
- **Synthesis-as-judge**: los agentes de síntesis deben deduplicar, descartar claims sin evidencia, preservar incertidumbre y elegir una recomendación concreta.
- **Crítica adversarial**: los reviewers tienen objetivo explícito de encontrar edge cases, reducir scope y marcar riesgos aceptados.
- **Manejo de fallas parciales**: la síntesis debe mencionar agentes fallidos, vacíos, cancelados o con timeout.
- **Seguridad por defecto**: para auditorías se refuerza “no edites archivos” y se mantienen tools read-only.

## Workflows actualizados

- `.pi/workflows/agentic-workflow-patterns-research.js`
- `.pi/workflows/background-workflow-implementation-plan.js`
- `.pi/workflows/review-dynamic-workflows.js`
- `.pi/workflows/revisar-estado-actual.js`
- `.pi/workflows/inventar-mejor-tui-workflows.js`
- `.pi/workflows/inventar-mejor-tui-workflows-lite.js`
- `.pi/workflows/karpathy-programming-recommendations-research.js`
- `examples/workflows/adversarial-plan-review.js`
- `examples/workflows/deep-research.js`
- `examples/workflows/repo-bug-hunt.js`

## Docs actualizadas

- `README.md`: sección “Patrones de prompts recomendados”.
- `skills/dynamic-workflows/SKILL.md`: sección “Prompting Patterns”.
- `docs/memoria.md`: preferencia persistente.

## Decisiones

- No se lanzó otro workflow para esta tarea porque los últimos workflows con subagentes quedaron colgados sin procesos visibles. Se hizo refactor directo y validable.
- No se agregó un helper compartido de prompts todavía para no acoplar ejemplos simples al runtime interno.
- Se privilegió mejorar prompts antes que cambiar la API.

## Validación esperada

- `node --check` sobre todos los workflows JS.
- Carga de extensión con `pi --no-extensions -e ./extensions/dynamic-workflows.ts --list-models __no_such_model__`.
