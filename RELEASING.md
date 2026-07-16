# Release de pandi-extensions

Este playbook deja una release reproducible para los dos canales de distribución: el **tag git de la suite** y los
paquetes npm `@pandi-coding-agent/*`. Usalo cuando `node scripts/publish-npm.mjs` diga que hay paquetes nuevos o
paquetes con contenido distinto que necesitan bump.

La idea base es simple: el root `package.json` versiona la suite completa y cada workspace npm conserva su versión
independiente. El tag git de la suite siempre es `v${root.version}`; los paquetes npm se publican solo cuando su tarball
cambió.

## Camino rápido

```bash
npm run release:flow
npm run release:go
npm run release:ship -- --confirm v0.3.20
```

`release:ship` es el camino normal: corre el preflight completo, crea un commit seguro, etiqueta y pushea. GitHub
Actions publica el tag con provenance. Para recuperar un fallo de CI, `npm run release:all -- --confirm vX.Y.Z` suma un
publish npm local con un plan fresco.

| Paso | Qué hace |
| ---- | -------- |
| `release:flow` | Dry-run: clasifica los workspaces y muestra el tag suite actual. |
| `release:go` | Preflight completo: bumps en loop (`--until-clean`), sync docs, `npm test`, contrato y plan final. |
| `release:ship -- --confirm vX.Y.Z` | Preflight completo, commit verificado (sin trailers `Co-authored-by`), tag y push. |
| `release:all -- --confirm vX.Y.Z` | Variante de recuperación que agrega el publish npm local con un plan recién generado. |

`release:go` y `release:ship` exigen árbol limpio. Para inspeccionar con cambios locales, corré:

```bash
node scripts/release-flow.mjs --go --allow-dirty
```

El plan `.release-plan.json` se regenera después del último bump y guarda versión de suite, SHA de Git y el shasum de
cada tarball. Antes de publicar desde un plan, `publish-npm` verifica que el checkout siga produciendo esos mismos
metadatos y tarballs; un plan stale falla cerrado en vez de publicar una versión incorrecta.

`--all` regenera el publish plan justo antes de publicar (no reutiliza un `.release-plan.json` viejo) y commitea con
`commit-tree` para evitar trailers `Co-authored-by` que algunos hosts inyectan en `git commit`. Para un preflight más
rápido en iteración: `node scripts/release-flow.mjs --all --fast --confirm v0.3.20` (`test:fast` en vez de `npm test`).

## Política de versiones

| Superficie   | Regla                                                                             |
| ------------ | --------------------------------------------------------------------------------- |
| Suite git    | `package.json` raíz es privado pero autoritativo; tag = `v${root.version}`.       |
| Paquetes npm | Versiones independientes por workspace; no se fuerza que todas coincidan.         |
| Patch        | Fixes, docs empaquetadas, cambios de prompts/mensajes, packaging y peer metadata. |
| Minor        | Nuevos comandos/tools, cambios user-facing grandes o breaking changes pre-1.0.    |
| Major        | Reservado para después de estabilizar 1.0.                                        |

Los peers se mantienen pinneados al piso soportado por el repo:

- `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`: `^0.80.3`.
- `typebox`: `^1.1.38`.

`node scripts/release-contract.mjs` falla si vuelve a aparecer `*` o si el tag esperado no coincide con la versión raíz.

## Comandos granulares (debug)

```bash
npm run release:prepare
npm run release:prepare:write -- --until-clean
node scripts/release-contract.mjs --expect-tag v0.3.20
node scripts/publish-npm.mjs --plan-file .release-plan.json
```

`release-prepare --until-clean` resuelve cascade bumps: si un bump actualiza pins internos, re-clasifica y sube
workspaces dependientes sin volver a tocar la versión suite.

## Publish en GitHub Actions

El workflow publica desde tags `v*` y también puede correrse manualmente en modo dry-run. El dry-run
escribe `.release-plan.json`; el paso de publish reutiliza ese plan con `--from-plan` para no reclasificar
los 29 workspaces.

Requisitos del repo en GitHub:

- Secret `NPM_TOKEN` con permiso de publish para `@pandi-coding-agent/*`.
- Permiso `id-token: write` ya declarado para publicar con provenance.

Para dry-run manual, usá `workflow_dispatch` con `publish=false`. Para publicar manualmente desde un commit ya validado,
seteá `publish=true` y, si corresponde, `expectedTag`.

El workflow `.github/workflows/publish.yml` vuelve a correr `npm test`, valida tag↔root version y ejecuta
`node scripts/publish-npm.mjs --from-plan .release-plan.json --publish --provenance`.

## Reintentos y publishes parciales

`publish-npm.mjs` es idempotente: antes de publicar consulta npm y saltea versiones ya publicadas. Si npm falla a mitad
de camino, re-ejecutá el workflow; los paquetes que ya llegaron a npm quedan como `unchanged` y no se sobrescriben.

El script pasa `--min-release-age=0` a los comandos npm para que una configuración local con `min-release-age` no
convierta paquetes recién publicados en falsos 404.

## Después de publicar: distro pi-cante / pandi

Si querés que las extensiones publicadas lleguen al bundle `pi-cante` / `pandi`, seguí el skill `pi-cante-releasing` en
el repo `/Users/andrestobelem/ws/at/pi-cante`:

```bash
node scripts/release-distros-flow.mjs
node scripts/release-distros-flow.mjs --prepare --commit --publish --push
```

En CI, usá el workflow **Release Distros** con `prepare`, `commit`, `publish`, `push` y el token de
`--print-confirmation`.

Ese paso es deliberadamente posterior: primero se publican los paquetes `@pandi-coding-agent/*`; después el distro
bump-ea sus pins y se publica con shrinkwrap propio.
