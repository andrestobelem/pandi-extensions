---
name: pi-cante-releasing
description: Publica y mantiene las distribuciones pi-cante / pandi (el fork del coding agent de pi en ~/ws/at/pi-cante que bundlea el pack de extensiones @pandi-coding-agent/*). Usar al publicar una nueva versión de una distro, actualizar los pins de extensiones bundleadas después de publicar extensiones desde este repo, sincronizar el fork con un nuevo tag de release upstream de pi, o agregar una distribución nueva. Cubre los scripts con estrategia dry-run-first, el esquema de versionado y los gotchas de npm/forks ganados con debugging real.
---

# Publicación de las distribuciones pi-cante / pandi

## Preparación: modelo mental primero

- **Fork**: `andrestobelem/pi-cante`, clon local en `/Users/andrestobelem/ws/at/pi-cante`, fork de `earendil-works/pi` (el monorepo de pi; la CLI vive en el workspace `packages/coding-agent`).
- **`main` siempre es `<upstream release TAG> + N distro commits`** — nunca el tip de `main` upstream. La dist debe compilarse contra las versiones *publicadas* de `@earendil-works/pi-*`; compilar desde tip rompe en instalación (aprendido por las malas).
- **Multi-distro**: `distros.json` declara las distribuciones que comparten un mismo workspace. Hoy:

  | key | npm | bin | configDir |
  |---|---|---|---|
  | `pi-cante` (default commiteado) | `@pandi-coding-agent/pi-cante` | `pi-cante` | `.pi-cante` |
  | `pandi` | `pandi-coding-agent` (sin scope — `@pandi-coding-agent/pandi` ya está tomado por la extensión *pandi*) | `pandi` | `.pandi` |

- **Versiones**: `<upstream base>-<distro>.<n>` (por ejemplo `0.80.3-cante.1`). Los prereleases de npm DEBEN publicarse explícitamente con `--tag latest`; `npm i -g` sigue el dist-tag, así que el orden semver no importa.
- Las 21 extensiones `@pandi-coding-agent/*` son `dependencies` **pineadas** y bloqueadas por el `npm-shrinkwrap.json` publicado — NO `bundledDependencies` (npm asume que esas dependencias ya están en el tarball y omite instalarlas en silencio; el workspace hoisting además las deja fuera del tarball).

## Los tres flujos

Todos los scripts hacen dry run por default. Ejecutá todo desde la raíz del fork. Documento completo: `RELEASING.md` dentro del fork.

### 1. Publicar las distros

```bash
node scripts/release-distros.mjs                 # dry run
node scripts/release-distros.mjs --publish       # real
node scripts/release-distros.mjs --only pandi --publish
```

Por distro: `set-distro` → build → subset de tests de branding → publish. Saltea versiones ya publicadas en npm; siempre restaura el default commiteado y verifica que el tree quede limpio. Requiere un tree limpio en `packages/coding-agent` y permisos para publicar en npm.

### 2. Actualizar los pins de extensiones bundleadas

Después de publicar nuevas versiones `@pandi-coding-agent/*` desde pandi-extensions (ahí: `node scripts/publish-npm.mjs --publish`):

```bash
node scripts/bump-extensions.mjs           # dry run: reporta pins desactualizados
node scripts/bump-extensions.mjs --write   # actualiza pins, bump de -<distro>.N, npm install, regenera locks
```

Después revisá el diff, commiteá con `PI_ALLOW_LOCKFILE_CHANGE=1 git commit ...` y corré el flujo 1.

### 3. Sincronizar con un nuevo release upstream

```bash
node scripts/sync-upstream.mjs           # dry run: base actual + tag upstream más nuevo
node scripts/sync-upstream.mjs v0.81.0   # rebasea los distro commits sobre el tag + verifica
```

Los conflictos suelen caer en `packages/coding-agent/package.json` y en lockfiles: quedate con el lado upstream y luego dejá que `set-distro` regenere. Cuando todo dé green: `git push --force-with-lease origin main` y después corré el flujo 1.

### Día típico de release

```text
pandi-extensions: publish-npm.mjs --publish
→ fork: bump-extensions --write → commit → release-distros --publish → push
```

## Agregar una distribución nueva

1. Agregá una entrada en `distros.json` (`name`/`bin`/`piConfig`/`versionSuffix`/`description`). Verificá PRIMERO que el nombre de npm esté libre (`npm view <name> version` → esperar `E404`).
2. Agregá ese nombre de npm a `internalPackageNames` en AMBOS archivos: `scripts/generate-coding-agent-shrinkwrap.mjs` y `scripts/generate-coding-agent-install-lock.mjs`.
3. `node scripts/set-distro.mjs <key>` → build → smoke (`dist/cli.js --version`, la config muestra el `APP`/`configDir`/`agentDir` correctos) → restore. Después publicala con el flujo 1.

## Trampas conocidas

Cada punto de esta lista costó debugging real:

- `~/.npmrc` tiene `min-release-age=7`: los packages recién publicados devuelven 404 sin `--min-release-age=0` (los scripts ya lo pasan). npm también puede poner en cuarentena publicaciones en ráfaga de la org (~1h de propagación).
- Los builds regeneran `packages/ai/src/providers/*.models.ts` como efecto colateral — descartalos con `git checkout -- packages/ai`; no los commitees.
- El pre-commit hook del fork bloquea cambios en lockfiles sin `PI_ALLOW_LOCKFILE_CHANGE=1`.
- `install-lock/` es interno del repo (no viaja en el tarball publicado); solo se publica el shrinkwrap, así que `set-distro` regenera únicamente el shrinkwrap.
- Las extensiones son conscientes del host desde `local-memory/auto-compact/goal/loop/worktree@0.2.0` y `dynamic-workflows/rename@0.3.0`: los paths van por `CONFIG_DIR_NAME`, y los spawns de subagentes por el `piConfig.name` del host (leído vía `getPackageDir()` — `APP_NAME` no está exportado por el SDK).
- Verificá un release de punta a punta en un contenedor efímero: `npm i -g <pkg>` en `node:24-slim`, y después chequeá `--version`, `configDir` y que `~/.pi` siga intacto.
