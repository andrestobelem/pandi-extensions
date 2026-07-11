# Manuales

Cuando necesitás la respuesta ya acordada, no una captura de momento, empezá acá. Esta carpeta reúne guías de referencia
duraderas para trabajar en el proyecto: convenciones, flujos, onboarding y el "así hacemos las cosas aquí". A diferencia
de `docs/research/` —que guarda notas puntuales— o de los handoffs de sesión —que son contexto transitorio—, estas
páginas se mantienen vigentes a medida que el proyecto evoluciona.

## En 30 segundos

- **Usá esta carpeta** para reglas que deberían seguir siendo válidas mañana: setup, naming, commits, testing y
  playbooks recurrentes.
- **No la uses** para investigación puntual, planes de implementación ni notas de avance.
- **Si dudás**, preguntate: "¿esto debería servirle igual a la próxima persona o sesión?" Si la respuesta es sí, va acá.

## Qué entra aquí

- Onboarding y setup del proyecto.
- Convenciones y decisiones de ingeniería pensadas para durar (naming, commits, testing).
- Procesos recurrentes y playbooks (cómo ejecutar/crear workflows, pasos de release).
- Cualquier cosa en la que una futura persona contribuidora o sesión deba poder confiar como vigente.

## Qué no entra aquí

- Investigación o indagación puntual → `docs/research/`.
- Handoffs de sesión o de trabajo ("dónde me quedé", "qué sigue") → dejalos transitorios.
- Planes de implementación o roadmaps → `docs/planes/`.

## Índice

- [Onboarding top-down para programadores](./top-down-onboarding.md) — mapa de lectura del repo, roles para repartir el
  trabajo y criterio para revisar comentarios/prosa traducida.
- [Catálogo de workflows (referencia rápida)](./workflow-catalog.md) — elegí una familia de dynamic workflows con una
  tabla o diagrama de decisión, y después explorá los 25 scaffolds por familia (enlaces a sus páginas HTML).
- [Glosario de skills: nombres, capas y deferencia](./glosario-skills.md) — producto vs skill vs tool vs patrón;
  `persona usuaria`, `vibe-coding` y lens skills.
- [Glosario de prompts: qué queda en inglés](./glosario-prompts.md) — la lista canónica de tokens congelados (tools,
  campos JSON, tokens de contrato como `PASS`/`NO_FINDINGS`) que ninguna traducción de prompts debe tocar.
- [Pandi artifact style (skill)](../../.pi/skills/pandi-artifact-style/SKILL.md) — manual de estilo para HTML artifacts,
  reportes y docs con estilo: layout Claude-design con la paleta Panda Syntax (tokens + template incluidos).
