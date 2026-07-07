# Personas de agente (`agentType`)

Una **persona** es un preset con nombre de `AgentOptions` que adjuntás a un subagente con `agentType: "<name>"`. Define valores razonables por defecto para `tools`, el razonamiento (`thinking`) y un `systemPrompt` de rol, para no repetirlos en cada llamada.

Fuente de verdad: `BUILTIN_AGENT_PERSONAS` en `extensions/pandi-dynamic-workflows/agent-env-persona.ts`. Los proyectos pueden sobreescribir una built-in —o agregar las suyas— con un archivo confiable `.pi/personas/<name>.json`, cuyas claves están limitadas a la allowlist persona-safe de `AgentOptions`.

## Precedencia y merge

```
agent({ agentType: "reviewer", model: "…", appendSystemPrompt: "…" })
  → .pi/personas/reviewer.json del proyecto (si existe y el proyecto es trusted)
  ?? BUILTIN_AGENT_PERSONAS["reviewer"]
  → se mezcla con las opciones explícitas de la llamada
```

- **Las opciones explícitas siempre ganan** sobre la persona (`{ ...persona, ...options }`).
- **`appendSystemPrompt` se concatena** (base de la persona + tu texto, `\n\n`), no se sobrescribe.
- Un `agentType` desconocido lanza error: nunca se ignora en silencio.

## Menú built-in

Todas las personas built-in usan por defecto **tools de solo lectura** (`READ_ONLY_AGENT_TOOLS`): inspeccionar, citar y proponer; nunca editar. Esta es una invariante de seguridad deliberada.

Si un paso necesita escribir o ejecutar, otorgá tools explícitamente en esa llamada (gana el override explícito de `tools`) o no uses una persona para ese paso.

| `agentType` | razonamiento | Usalo para | Prompt de rol (resumen) |
| --- | --- | --- | --- |
| `explore` | medium | Exploración o descubrimiento amplio sobre un repositorio o corpus | Explorar con amplitud, pero con evidencia; priorizar inspección read-only, citar archivos/líneas y señalar incertidumbre. |
| `researcher` | high | Recolección independiente de evidencia, comparación de alternativas | Reunir evidencia independiente, comparar alternativas, citar fuentes o archivos y separar hechos de supuestos. |
| `planner` | high | Descomposición, mapeo de dependencias/riesgos, enrutamiento | Descomponer la tarea, identificar dependencias y riesgos, y proponer un plan mínimo verificable con costos/beneficios claros. |
| `architect` | high | **Diseño** de la solución (distinto de la planificación) | Dar forma al diseño de la solución: definir componentes, interfaces, límites y flujo de datos; sopesar costos/beneficios y restricciones; justificar según los requisitos. |
| `implementer` | medium | Diseño de un patch/diff concreto | Preferir cambios mínimos, preservar el comportamiento existente y explicar los pasos de verificación; no editar salvo que quien llama lo permita explícitamente. |
| `reviewer` | high | Revisión escéptica / QA / gating de output riesgoso | Buscar riesgos de corrección, seguridad, concurrencia y mantenibilidad; citar evidencia concreta; no editar archivos. |

## `planner` vs `architect`

Son complementarias, no redundantes. La separación refleja una taxonomía recurrente de roles multiagente (por ejemplo, Planner/PM vs. Architect de MetaGPT):

- **`planner`** se ocupa de la *descomposición y el enrutamiento*: qué pasos dar, en qué orden, con qué dependencias y riesgos.
- **`architect`** se ocupa de la *forma de la solución*: componentes, interfaces, límites, flujo de datos y los costos/beneficios detrás.

Usá `planner` para decidir **qué hacer**; usá `architect` para decidir **cómo se estructura la solución**.

## Notas

- Los valores por defecto de razonamiento se mapean a la escala de esfuerzo del motor; pasá `effort`/`thinking` explícitamente para sobreescribirlos.
- Las personas solo configuran las claves de opción persona-safe (`tools`, `excludeTools`, `skills`, `includeSkills`, `extensions`, `model`, `provider`, `thinking`, `includeExtensions`, `approve`, `useContextFiles`, `systemPrompt`, `appendSystemPrompt`, `timeoutMs`, `keys`, `env`, `inheritEnv`).
- Intencionalmente no hay ningún built-in `executor`: un ejecutor de tools/código rompería la invariante de solo lectura por defecto. En cambio, otorgá tools de escritura/ejecución explícitamente en una llamada específica, como decisión consciente.
