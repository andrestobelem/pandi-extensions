# Release de pandi-extensions

Este playbook deja una release reproducible para los dos canales de distribución: el **tag git de la suite** y los paquetes npm `@pandi-coding-agent/*`. Usalo cuando `node scripts/publish-npm.mjs` diga que hay paquetes nuevos o paquetes con contenido distinto que necesitan bump.

La idea base es simple: el root `package.json` versiona la suite completa y cada workspace npm conserva su versión independiente. El tag git de la suite siempre es `v${root.version}`; los paquetes npm se publican solo cuando su tarball cambió.

## Camino rápido

```bash
npm test
npm run release:prepare
node scripts/release-contract.mjs --expect-tag v0.3.4
node scripts/publish-npm.mjs
```

Si `release:prepare` lista paquetes `BUMP?`, aplicá el bump automático y repetí los checks:

```bash
npm run release:prepare:write
npm run sync:docs:html
npm test
node scripts/release-contract.mjs --expect-tag v0.3.4
node scripts/publish-npm.mjs
```

Si todo está verde y el dry-run lista solo paquetes `PUBLISH`/`unchanged` sin `BUMP?`, creá el tag de suite y dejá que GitHub Actions publique:

```bash
git tag v0.3.4
git push origin v0.3.4
```

El workflow `.github/workflows/publish.yml` vuelve a correr `npm test`, valida tag↔root version y ejecuta `node scripts/publish-npm.mjs --publish --provenance`.

## Política de versiones

| Superficie | Regla |
| --- | --- |
| Suite git | `package.json` raíz es privado pero autoritativo; tag = `v${root.version}`. |
| Paquetes npm | Versiones independientes por workspace; no se fuerza que todas coincidan. |
| Patch | Fixes, docs empaquetadas, cambios de prompts/mensajes, packaging y peer metadata. |
| Minor | Nuevos comandos/tools, cambios user-facing grandes o breaking changes pre-1.0. |
| Major | Reservado para después de estabilizar 1.0. |

Los peers se mantienen pinneados al piso soportado por el repo:

- `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`: `^0.80.3`.
- `typebox`: `^1.1.38`.

`node scripts/release-contract.mjs` falla si vuelve a aparecer `*` o si el tag esperado no coincide con la versión raíz.

## Preflight antes de taggear

1. Verificá el árbol:

   ```bash
   git status --short --branch
   npm test
   ```

2. Prepará bumps pendientes de forma segura:

   ```bash
   npm run release:prepare       # dry-run: muestra root + workspaces que subirían patch
   npm run release:prepare:write # write: actualiza package.json, package-lock y docs de release
   npm run sync:docs:html        # si el write tocó docs/setup.md o RELEASING.md
   ```

3. Validá el contrato de release:

   ```bash
   node scripts/release-contract.mjs --expect-tag v0.3.4
   ```

4. Revisá npm sin publicar:

   ```bash
   node scripts/publish-npm.mjs
   ```

   - `PUBLISH`: versión todavía no existe en npm; está lista para publicar.
   - `unchanged`: tarball local idéntico al publicado; se saltea.
   - `BUMP?`: esa versión ya existe pero el contenido cambió; bump-eá el workspace antes de taggear.

## Publish en GitHub Actions

El workflow publica desde tags `v*` y también puede correrse manualmente en modo dry-run.

Requisitos del repo en GitHub:

- Secret `NPM_TOKEN` con permiso de publish para `@pandi-coding-agent/*`.
- Permiso `id-token: write` ya declarado para publicar con provenance.

Para dry-run manual, usá `workflow_dispatch` con `publish=false`. Para publicar manualmente desde un commit ya validado, seteá `publish=true` y, si corresponde, `expectedTag`.

## Reintentos y publishes parciales

`publish-npm.mjs` es idempotente: antes de publicar consulta npm y saltea versiones ya publicadas. Si npm falla a mitad de camino, re-ejecutá el workflow; los paquetes que ya llegaron a npm quedan como `unchanged` y no se sobrescriben.

El script pasa `--min-release-age=0` a los comandos npm para que una configuración local con `min-release-age` no convierta paquetes recién publicados en falsos 404.

## Después de publicar: distro pi-cante / pandi

Si querés que las extensiones publicadas lleguen al bundle `pi-cante` / `pandi`, seguí el skill `pi-cante-releasing` en el repo `/Users/andrestobelem/ws/at/pi-cante`:

```bash
node scripts/bump-extensions.mjs
node scripts/bump-extensions.mjs --write
node scripts/release-distros.mjs --publish
```

Ese paso es deliberadamente posterior: primero se publican los paquetes `@pandi-coding-agent/*`; después el distro bump-ea sus pins y se publica con shrinkwrap propio.
