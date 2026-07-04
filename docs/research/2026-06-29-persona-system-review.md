# Sistema de Personas (agentType) — Code Review

Date: 2026-06-29

## Objetivo

Revisar el subsistema de **Personas** de `pandi-dynamic-workflows`: dónde se definen, cómo se resuelven/fusionan, y qué riesgos de correctitud, seguridad y consistencia tiene. Lente: skeptical code reviewer, read-only, con cita `file:line`.

## Dónde vive

- **Definición:** `extensions/pandi-dynamic-workflows/agent-env-persona.ts`
  — `BUILTIN_AGENT_PERSONAS` (5 personas, líneas 27–58) + resolución/merge/carga.
- **Personas de proyecto:** archivos `.pi/personas/<name>.json` (`loadProjectPersona`, línea 228).
  Hoy **no hay ninguna** en el repo.
- **Aplicación:** `index.ts:713` → `applyPersonaOptions` (antes de `applyDefaultAgentAccess`).
- **Uso real:** `.pi/workflows/*.js` (loop-engineering, modularize-audit) + tests + README.
  Las 5 personas: `explore·medium`, `reviewer·high`, `planner·high`, `implementer·medium`,
  `researcher·high` — coinciden exacto con el README raíz y el skill `ultracode`.

## Lo que está bien (no tocar)

- **Gate de confianza** (`agent-env-persona.ts:229`): proyecto no-confiable → ignora
  `.pi/personas/*` y cae a built-in. Correcto: una persona puede setear `env`/`keys`/`tools`/
  `systemPrompt`, todos poderosos.

- **Path traversal bloqueado**: el regex `/^[a-zA-Z0-9._-]+$/` (línea 223) prohíbe `/` y `\`, así
  que `${name}.json` no escapa del directorio de personas.

- `sanitizePersonaOptions` (línea 199) **no** copia `agentType` → un JSON de proyecto no puede
  re-disparar la resolución (sin recursión) ni inyectar `schema`/`prompt`.

- `appendSystemPrompt` se concatena de forma determinista (línea 211); merge determinista; los
  niveles de `thinking` respetan el contrato documentado.

## Hallazgos (por peso)

### 1. `systemPrompt` se pisa, `appendSystemPrompt` se fusiona — asimetría

`mergePersonaOptions` (líneas 210–219) hace `{...persona, ...options}`. La **identidad** de cada
persona (lo que hace que `reviewer` sea escéptico) vive en `systemPrompt`, que es un campo
pisable: si el caller pasa su propio `systemPrompt`, **borra entero** el de la persona y sólo
`appendSystemPrompt` sobrevive (concatenado).

Resultado: podés pedir `agentType:"reviewer"` y, si además pasás `systemPrompt`, la reviewer-ness
desaparece en silencio. Es coherente con "lo explícito gana", pero el comportamiento identitario
quedó en el campo clobbereable.

**Fix:** si las personas deben ser *defaults pegajosos*, mover su prompt de identidad a
`appendSystemPrompt`; si no, documentar explícitamente el clobber. **Es el punto más sustantivo.**

### 2. Resolución case-insensitive para built-in, case-sensitive para proyecto

Built-in: `BUILTIN_AGENT_PERSONAS[name.toLowerCase()]` (línea 246). Proyecto: `${name}.json` con
case preservado (líneas 230–231). En sistemas de archivos case-sensitive (Linux/CI), `agentType:"Reviewer"`
**no** encuentra `Reviewer.json` pero **sí** el built-in `reviewer` → usa el built-in en silencio aunque
hubiera un override de proyecto.

En macOS el comportamiento del sistema de archivos lo tapa.

**Fix de 1 línea:** bajar a minúscula en ambos lados (o en ninguno) para que built-in y proyecto
resuelvan igual.

### 3. `sanitizePersonaOptions` valida claves pero no tipos

`agent-env-persona.ts:199–208` copia las claves whitelisteadas tal cual. Un `Reviewer.json` con
`tools:"read"` (string en vez de array) pasa derecho; `applyDefaultAgentAccess` sólo se cubre con
`Array.isArray(out.tools)` (línea 329), otros consumidores asumen array.

**Riesgo:** bajo (gateado por confianza). **Fix:** chequeo de tipo por clave al sanitizar.

### 4. `implementer`: el prompt promete editar, los tools no dejan

`agent-env-persona.ts:46–51`: el `systemPrompt` dice "Do not edit files unless explicitly allowed
by the caller", pero el default es `READ_ONLY_AGENT_TOOLS`. "Allowed" exige que el caller
**también** override `tools` (con `approve` solo no alcanza).

El comportamiento es seguro y conservador; sólo la redacción induce a error.

**Fix:** aclarar en el prompt que editar requiere que el caller provea tools de escritura.

### 5. Los scaffolds publicados NO usan personas (0/25)

`agentType` aparece en `.pi/workflows/` (ejemplos), tests y README — pero ningún archivo de
`scaffolds/` lo usa; ahí se rutea todo por `node(role)` + mapas `models{}`/`efforts{}`.

Conviven dos mecanismos: **persona** (`systemPrompt` + `thinking`) vs **node-role** (`model`/`effort`).
No es bug, pero los scaffolds hoy sólo heredan model/effort, no la **identidad** (el `systemPrompt`
escéptico, etc.). Decisión pendiente: ¿adoptar `agentType` en los scaffolds?

### 6. Doc gap (menor)

El README de la extensión (`extensions/pandi-dynamic-workflows/README.md`) no menciona personas; sí
lo hacen el README raíz (líneas 158, 402, 500, 525) y el skill.

## Orden sugerido de arreglo

1. **#2** — bug real cross-plataforma, fix de 1 línea.
2. **#1** — decisión de diseño: mover identidad a `appendSystemPrompt` o documentar el clobber.
3. #3 / #4 / #6 — hardening + claridad, bajo riesgo.
4. #5 — decisión de producto, no urgente.
