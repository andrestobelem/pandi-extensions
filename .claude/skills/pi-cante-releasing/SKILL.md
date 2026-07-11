---
name: pi-cante-releasing
description:
  Publicá y mantené las distribuciones `pi-cante` / `pandi` al lanzar versiones, actualizar pins de extensiones,
  sincronizar el fork con upstream o agregar una distribución.
---

# Publicación de las distribuciones pi-cante / pandi

## En 30 segundos

Publicá forks `pi-cante` / `pandi` desde el clon local del fork (`pi-cante`). Todos los scripts simulan por defecto; la
receta operativa canónica está en `RELEASING.md` del fork.

```bash
node scripts/release-distros-flow.mjs
node scripts/release-distros-flow.mjs --prepare --commit --publish --push
```

## Preparación: modelo mental primero

- **Fork**: `andrestobelem/pi-cante`, clon local en `/Users/andrestobelem/ws/at/pi-cante`, fork de `earendil-works/pi`
  (el monorepo de pi; la CLI vive en el workspace `packages/coding-agent`).
- **`main` siempre es `<upstream release TAG> + N distro commits`** — nunca el tip de `main` upstream. La dist debe
  compilarse contra las versiones _publicadas_ de `@earendil-works/pi-*`; compilar desde tip rompe en instalación
  (aprendido por las malas).
- **Multi-distro**: `distros.json` declara las distribuciones que comparten un mismo workspace. Hoy:

  | key                             | npm                                                                                                    | bin        | configDir   |
  | ------------------------------- | ------------------------------------------------------------------------------------------------------ | ---------- | ----------- |
  | `pi-cante` (default commiteado) | `@pandi-coding-agent/pi-cante`                                                                         | `picante`  | `.pi-cante` |
  | `pandi`                         | `pandi-coding-agent` (sin scope — `@pandi-coding-agent/pandi` ya está tomado por la extensión _pandi_) | `pandi`    | `.pandi`    |

- **Versiones**: `<upstream base>-<distro>.<n>` (por ejemplo `0.80.3-cante.1`). Los prereleases de npm DEBEN publicarse
  explícitamente con `--tag latest`; `npm i -g` sigue el dist-tag, así que el orden semver no importa.
- Las 21 extensiones `@pandi-coding-agent/*` son `dependencies` **pineadas** y bloqueadas por el `npm-shrinkwrap.json`
  publicado — NO `bundledDependencies` (npm asume que esas dependencias ya están en el tarball y omite instalarlas en
  silencio; el workspace hoisting además las deja fuera del tarball).

## Antes de ejecutar

Todos los scripts hacen simulación por defecto (`dry run`). Ejecutá todo desde la raíz del fork. **Antes de ejecutar
cualquiera de estos flujos, leé `/Users/andrestobelem/ws/at/pi-cante/RELEASING.md`:** este skill es el mapa de decisión
y ese documento es la receta operativa canónica, incluida la variante orquestada `release-distros-flow`.

## Flujos

### 1. Publicar las distros

1. Corré el preflight orquestado:

   ```bash
   node scripts/release-distros-flow.mjs
   node scripts/release-distros-flow.mjs --only pandi
   ```

   **Cierre:** la simulación termina con exit 0, informa las versiones objetivo y el árbol tracked está limpio.

2. Prepará, commiteá y publicá con el orquestador:

   Antes de usar `--publish`, mostrale a la persona usuaria las distros y versiones objetivo de la simulación y pedí
   confirmación explícita. Un dry run exitoso demuestra preparación; no autoriza por sí mismo la publicación.

   ```bash
   node scripts/release-distros-flow.mjs --prepare --commit
   node scripts/release-distros-flow.mjs --print-confirmation
   node scripts/release-distros-flow.mjs --publish --push --confirm '<token>'
   ```

   Equivalente en un solo paso cuando el árbol ya está listo:

   ```bash
   node scripts/release-distros-flow.mjs --prepare --commit --publish --push
   ```

   Por distro: `set-distro` → build → subset de tests de branding → publish. Saltea versiones ya publicadas en npm y
   restaura el valor por defecto commiteado.

   **Cierre:** el publish termina con exit 0, npm muestra `latest` en la versión objetivo y el smoke post-publicación pasa.

3. El smoke ya corre dentro de `--publish`; solo re-ejecutalo manualmente si estás depurando:

   ```bash
   node scripts/smoke-distros.mjs
   node scripts/smoke-distros.mjs --only pandi
   ```

   **Cierre:** el smoke instala cada distro objetivo y sus comandos `--version` y `--help` terminan con exit 0.

### 2. Actualizar los pins de extensiones incluidas

Después de publicar nuevas versiones `@pandi-coding-agent/*` desde pandi-extensions (ahí:
`node scripts/publish-npm.mjs --publish`):

1. Inspeccioná los pins que cambiarían:

   ```bash
   node scripts/bump-extensions.mjs
   ```

   **Cierre:** la simulación enumera los pins desactualizados esperados.

2. Aplicá el cambio y regenerá los locks:

   ```bash
   node scripts/bump-extensions.mjs --write
   ```

   **Cierre:** termina con exit 0 y el diff contiene solo los pins, versiones y artifacts de lock esperados.

3. Revisá el diff, commiteá con `PI_ALLOW_LOCKFILE_CHANGE=1 git commit ...` y corré el flujo 1.

   **Cierre:** el commit contiene los artifacts esperados y la publicación más su smoke terminan con exit 0.

### 3. Sincronizar con un nuevo release upstream

1. Inspeccioná la base y el tag disponibles:

   ```bash
   node scripts/sync-upstream.mjs
   ```

   **Cierre:** la simulación informa la base actual y el tag upstream objetivo.

2. Rebaseá los commits de distro sobre ese tag:

   ```bash
   node scripts/sync-upstream.mjs v0.81.0
   ```

   Los conflictos suelen caer en `packages/coding-agent/package.json` y en lockfiles: quedate con el lado upstream y
   luego dejá que `set-distro` regenere.

   **Cierre:** el script termina con exit 0 tras regenerar, compilar y ejecutar sus verificaciones.

3. Corré el flujo 1. Después mostrá la rama, la base upstream y los commits que se van a reescribir, y pedí confirmación
   explícita inmediatamente antes de ejecutar `git push --force-with-lease origin main`.

   **Cierre:** la publicación y el smoke post-publicación terminan con exit 0.

### Día típico de release

```text
pandi-extensions: publish-npm.mjs --publish
→ fork: release-distros-flow --prepare --commit --publish --push
```

## Agregar una distribución nueva

1. Agregá una entrada en `distros.json` (`name`/`bin`/`piConfig`/`versionSuffix`/`description`). Verificá PRIMERO que el
   nombre de npm esté libre (`npm view <name> version` → esperar `E404`).
2. Agregá ese nombre de npm a `internalPackageNames` en AMBOS archivos: `scripts/generate-coding-agent-shrinkwrap.mjs` y
   `scripts/generate-coding-agent-install-lock.mjs`.
3. `node scripts/set-distro.mjs <key>` → build → smoke (`dist/cli.js --version`, la config muestra el
   `APP`/`configDir`/`agentDir` correctos) → restore. Después publicala con el flujo 1.

   **Cierre:** el nombre está libre, los dos generadores de lock lo incluyen y build, smoke, restore y publicación
   terminan con exit 0.

## Trampas conocidas

Cada punto de esta lista costó depuración real:

- `~/.npmrc` tiene `min-release-age=7`: los paquetes recién publicados devuelven 404 sin `--min-release-age=0` (los
  scripts ya lo pasan). npm también puede poner en cuarentena publicaciones en ráfaga de la org (~1h de propagación).
- Los builds regeneran `packages/ai/src/providers/*.models.ts` como efecto colateral. Exigí que `packages/ai` esté
  limpio antes del build; si ya tiene cambios, frená. Después inspeccioná `git diff -- packages/ai` y restaurá
  únicamente los archivos que cambió el build, con confirmación explícita. No uses una restauración amplia que pueda
  borrar trabajo previo.
- El hook de pre-commit del fork bloquea cambios en lockfiles sin `PI_ALLOW_LOCKFILE_CHANGE=1`.
- `install-lock/` es interno del repo (no viaja en el tarball publicado); solo se publica el shrinkwrap, así que
  `set-distro` regenera únicamente el shrinkwrap.
- Las extensiones son conscientes del host desde `local-memory/auto-compact/goal/loop/worktree@0.2.0` y
  `dynamic-workflows/rename@0.3.0`: los paths van por `CONFIG_DIR_NAME`, y los spawns de subagentes por el
  `piConfig.name` del host (leído vía `getPackageDir()` — `APP_NAME` no está exportado por el SDK).
