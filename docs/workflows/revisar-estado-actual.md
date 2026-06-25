# Workflow: revisar estado actual

Fecha: 2026-06-25
Workflow: `.pi/workflows/revisar-estado-actual.js`

## Objetivo

Crear un workflow para revisar el estado actual del repositorio y sintetizar:

- Estado del working tree.
- Archivos nuevos o modificados.
- Salud de implementación, documentación, ejemplos y packaging.
- Verificaciones ejecutadas u omitidas.
- Riesgos, bloqueadores y próximos pasos.

## Qué hace el workflow

1. Recolecta baseline del repositorio:
   - `git status --short --branch`
   - `git log --oneline --decorate -8`
   - `git diff --stat && git diff --cached --stat`
   - `git ls-files`
   - `git ls-files --others --exclude-standard`
   - árbol de archivos sin `.git`
   - búsqueda de `TODO|FIXME|XXX|HACK|BUG`

2. Lee `package.json` de forma segura.

3. Opcionalmente puede ejecutar scripts de verificación si se llama con `runChecks: true`:
   - `npm run lint`
   - `npm run typecheck`
   - `npm run test`
   - `npm run build`

4. Selecciona archivos relevantes:
   - `package.json`
   - `README.md`
   - `LICENSE`
   - `.gitignore`
   - `skills/dynamic-workflows/SKILL.md`
   - `extensions/dynamic-workflows.ts`
   - `examples/workflows/*.js`
   - `.pi/workflows/*.js`

5. Lanza subagentes paralelos con estos focos:
   - `git-y-estructura`
   - `implementacion-runtime`
   - `docs-skill-ejemplos`
   - `verificacion-y-siguientes-pasos`

6. Genera una síntesis final en español.

## Artefactos esperados

El workflow escribe artefactos en `.pi/workflow-runs/<run-id>/`:

- `baseline.json`
- `relevant-files.json`
- `reviews.json`
- `estado-actual.md`

## Validaciones realizadas

- Se validó sintaxis con:

```bash
node --check .pi/workflows/revisar-estado-actual.js
```

Resultado: sin errores.

## Ejecuciones registradas

### Run 1

Run ID:

```text
2026-06-25T05-13-09-630Z-revisar-estado-actual-653459f8
```

Estado observado: `stale`.

Notas:

- El workflow recolectó correctamente el baseline.
- Llegó a iniciar 4 subagentes.
- Quedó marcado como `running` en disco pero no activo en la sesión de Pi.
- Artefactos existentes:
  - `baseline.json`
  - `events.jsonl`
  - `input.json`
  - `relevant-files.json`
  - `status.json`

### Run 2

Run ID:

```text
2026-06-25T05-16-10-490Z-revisar-estado-actual-a47adcb7
```

Estado final observado: `completed`.

Parámetros:

```json
{
  "runChecks": false,
  "maxFiles": 2000
}
```

Límites usados:

- `concurrency`: 2
- `maxAgents`: 6
- `timeoutMs`: 900000
- `agentTimeoutMs`: 600000

Artefactos finales:

- `agents/0001-git-y-estructura.md`
- `agents/0002-implementacion-runtime.md`
- `agents/0003-docs-skill-ejemplos.md`
- `agents/0004-verificacion-y-siguientes-pasos.md`
- `agents/0005-sintesis-estado-actual.md`
- `baseline.json`
- `estado-actual.md`
- `result.json`
- `reviews.json`
- `summary.md`

Hallazgos principales del run:

- El working tree está sucio y gran parte del paquete nuevo sigue sin versionar.
- El manifest de `package.json` es coherente con un paquete Pi, pero los recursos apuntados todavía aparecen como untracked.
- No hay scripts de `lint`, `typecheck`, `test` ni `build`.
- Riesgo en `examples/workflows/deep-research.js`: concede `bash` a subagentes y el runtime puede usar `--approve` en proyectos trusted.
- Los ejemplos/README pueden fallar si `maxAgents` es menor que `maxFiles + síntesis`.

## Cómo ejecutarlo

```json
{
  "action": "run",
  "name": "revisar-estado-actual",
  "scope": "project",
  "input": {
    "runChecks": false,
    "maxFiles": 2000
  },
  "concurrency": 2,
  "maxAgents": 6,
  "timeoutMs": 900000,
  "agentTimeoutMs": 600000
}
```

Para correrlo en background:

```json
{
  "action": "start",
  "name": "revisar-estado-actual",
  "scope": "project",
  "input": {
    "runChecks": false,
    "maxFiles": 2000
  },
  "concurrency": 2,
  "maxAgents": 6,
  "timeoutMs": 900000,
  "agentTimeoutMs": 600000
}
```

## Próximos pasos

1. Versionar los archivos publicables del paquete o decidir qué queda local.
2. Decidir política para `.pi/` y `.pi/workflows/`.
3. Agregar scripts en `package.json` para poder ejecutar checks reales (`lint`, `typecheck`, `test`, `build`).
4. Endurecer ejemplos que usan `bash` o hacerlos opt-in.
5. Ajustar límites documentados para que `maxAgents` alcance para `maxFiles` más síntesis.
