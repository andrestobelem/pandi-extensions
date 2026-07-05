# Checklist de code review — extensiones Pandi (pandi-extensions)

Esta checklist ayuda a revisar cambios en extensiones sin perder de vista el alcance, la calidad técnica y la forma de publicar.
Sirve para decidir rápido si un PR está listo o si todavía le faltan tests, limpieza o verificación de empaquetado.

## En 30 segundos

Si el cambio toca una extensión, revisá primero el alcance, después el contrato de diseño y por último la evidencia: tests, typecheck, lint, empaquetado y commit.
Cada ítem trae el comando que lo verifica, así la review no depende de memoria.

Fuentes: `AGENTS.md`, `docs/principios-ingenieria.md`, `package.json`, `extensions/*/package.json`,
`scripts/test/run-all.mjs`. Cada ítem indica qué mirar y el comando que lo verifica.

## 1. Contrato y alcance

- [ ] El PR o commit toca solo lo que pide la tarea (`git diff --stat`); sin "mejoras"
      adyacentes no pedidas ni refactors fuera de alcance.
- [ ] Una extensión nueva vive en `extensions/<pi-ext>/` con su propio `package.json` (no
      colgada de otra extensión ni de `extensions/shared/`).
- [ ] Si el cambio toca `extensions/shared/`, lo agregado vive bajo `extensions/shared/test/`
      (harness/fixtures), no runtime: `ls extensions/shared/` solo debe listar `test/`.

## 2. Diseño y duplicación intencional

- [ ] Ningún import runtime cruza el límite de la extensión (ni siquiera hacia
      `../shared`, que solo vale en tests): `grep -rn "from \"\.\./" extensions/*/*.ts` sale
      vacío (self-contained, jiti). Supone `.ts` plano en `extensions/<ext>/`; con
      subdirs usar `git grep 'from "\.\./' -- 'extensions/*/**.ts' ':!*/tests/*'`
      (cubre depth-1 y subcarpetas por igual).
- [ ] Si el cambio intenta hacer DRY de `notify.ts`/`time.ts`/`session-state.ts`/parsers de flags
      moviéndolos a un módulo compartido entre extensiones, es un antipatrón: revertirlo
      y dejar la duplicación intra-repo (intencional). Dedup solo dentro de la misma extensión.
- [ ] Toda abstracción/config/flag nueva (incluidas ramas de un solo uso) tiene al menos
      un llamador o test real que la ejerza (`grep` del símbolo nuevo dentro del diff/PR);
      si es de un solo uso o no hay un caso real que la use, inlinear o cortar.

## 3. Tests (TDD completo)

- [ ] El test que fija el bug o la feature se escribió antes del código (Red primero); si no se
      puede verificar test-first, el PR lo declara explícitamente en vez de llamarlo TDD.
- [ ] El test vive en `extensions/<ext>/tests/integration/*.test.mjs` (convención de
      descubrimiento): `node scripts/test/run-all.mjs --list` lo lista.
- [ ] La suite corre en verde: `node scripts/test/run-all.mjs`.
- [ ] El PR narra el paso de Refactor explícitamente (qué se simplificó o "nada que
      cambiar, porque X") — no puede estar ausente ni implícito.
- [ ] Las suites excluidas del runner están listadas con motivo en `ignoredDraftSuites`
      (`scripts/test/run-all.mjs`) — nunca se saltan en silencio.

## 4. Código

- [ ] Los tipos están correctos, sin `any` innecesario: `npm run typecheck` (`tsc -p tsconfig.json`,
      `include: extensions/**/*.ts`) pasa sin errores.
- [ ] El estilo y el lint están conformes con el repo: `npm run check` (biome, `biome.jsonc`) pasa sin
      warnings nuevos. Para corregir, NO usar `npm run check:fix` (reescribe todo el
      repo vía `biome check --write .`); usar `npx biome check --write <archivos-tocados>`
      y confirmar con `git diff --stat` que solo cambiaron los archivos esperados.
- [ ] Todo `try/catch`/rama de error/`if` defensivo nuevo tiene aserción en el
      `*-coverage.test.mjs` de la extensión (p. ej.
      `extensions/pandi-goal/tests/integration/index-coverage.test.mjs`); sin caso real
      que la dispare, eliminar la rama.
- [ ] El Markdown tocado (README, skills, docs) pasa `npm run lint:md` (markdownlint-cli2).

## 5. Empaquetado (publish standalone)

- [ ] `files[]` cubre todos los `.ts` importados por `index.ts` directa o transitivamente
      (siblings se importan con `.js`, resuelve al `.ts` real vía jiti). Supone `.ts` plano
      en `extensions/<ext>/`; con subdirs usar la misma forma `git grep` de 2.1:
      `git grep -hoE 'from "\./[A-Za-z0-9_-]+\.(js|ts)"' -- 'extensions/<ext>/**.ts'
      ':!*/tests/*' | sed 's/\.js"/.ts"/'` — cada `.ts` resultante debe estar en `files[]`.
- [ ] Las subcarpetas referenciadas (`scripts/`, `themes/`, `primitives/`, `skills/`) están
      declaradas en `files[]` (ver `pandi-doctor`→`scripts`, `pandi-dynamic-workflows`→
      `scaffolds`/`primitives`/`skills`, `pandi-theme`→`themes`).
- [ ] `pi.extensions` del `package.json` de la extensión apunta al entrypoint real y
      coincide con el manifiesto root.
- [ ] El manifiesto root se regenera, no se edita a mano, si cambió el catálogo:
      `npm run sync:manifest:check`.
- [ ] Las skills/guías vendorizadas por la extensión, si aplica, no driftan:
      `npm run sync:skills:check`, `npm run sync:agents:check`, `npm run doctor`.
- [ ] El tarball real: `npm pack -w extensions/<ext> --dry-run` (por RUTA; el nombre npm
      omite `pi-`, ej. `pandi-goal`→`@pandi-coding-agent/pandi-goal`) incluye todos los archivos
      runtime, no solo `index.ts`.

## 6. Suite completa y commit

- [ ] `npm test` (typecheck + biome check + lint:md + `sync:docs:html:check` + `sync:personas:check` + `test:unit` + `test:integration`) pasa completo,
      no solo la suite de la extensión tocada.
- [ ] El commit es atómico: un cambio coherente, con el test de fijación en el MISMO commit
      que el código (`git show --stat HEAD` confirma ambos juntos).
- [ ] El mensaje usa Conventional Commits con scope explícito de la extensión, p. ej.
      `fix(pi-goal): clear terminated goals` — sin scope genérico `fix: ...`.
- [ ] Sin `Co-Authored-By:` ni atribución a herramienta/IA:
      `git log -1 --format=%B | grep -i "co-authored-by\|generated with"` no matchea nada.
- [ ] Antes de amendar: `git log`/`git reflog` confirma que `HEAD` es el commit propio
      (sesiones concurrentes pueden haber commiteado encima).
