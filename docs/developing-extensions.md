# Desarrollar y probar extensiones en pi

Fecha: 2026-07-03

Esta guía es la fuente autoritativa de **cómo desarrollar una extensión de este
repo y probarla a la vez**, sin romper la sesión con la que trabajás.

El problema nace de que este repo es **auto-hospedado**: la suite está instalada
globalmente apuntando al propio checkout
(`packages: ["../../ws/at/pi-dynamic-workflows"]` en `~/.pi/agent/settings.json`),
y **pi carga el TypeScript de las extensiones desde disco** (no bundlea). Entonces
un `/reload` en tu sesión de trabajo ejecuta tus edits **sin commitear** al
instante — y un error de sintaxis o de carga puede tumbar esa sesión.

La clave para no sufrirlo es separar **tres ejes ortogonales** que se confunden
entre sí. Cada uno se resuelve con una herramienta distinta.

## Eje 1 — Corrección: ¿mi edit funciona?

**Loop primario. Sin riesgo para tu sesión. Es TDD (la vía Farley).**

Los tests de integración **no cargan la extensión en tu sesión**: el harness
compartido (`extensions/shared/test/harness.mjs`) hace un esbuild-bundle de la
extensión a un directorio temporal y la importa dinámicamente con un `ctx`
mockeado. Es aislado y rápido.

```bash
# una suite puntual (segundos) — el loop de desarrollo
node --test extensions/pi-<ext>/tests/integration/<algo>.test.mjs

# todo el gate antes de commitear (typecheck + biome + markdownlint + suites)
npm test
```

- `scripts/test/run-all.mjs` **auto-descubre** toda suite
  `extensions/<ext>/tests/integration/*.test.mjs` (no hay manifest hardcodeado);
  para excluir una suite todavía-no-verde se usa su denylist `ignoredDraftSuites`.
- Escribí el test **antes** que la implementación (Red → Green → Refactor →
  Commit). Si un comportamiento "solo se puede ver en vivo", suele faltar
  cubrirlo con un test aislado.

Este eje debería ser ~90% de tu dev-test. Los ejes 2 y 3 son complementos, no
sustitutos.

## Eje 2 — Seguridad de sesión: ¿un edit roto me tumba la sesión?

Este es el problema puntual del repo auto-hospedado. El mecanismo in-place es
`/reload` (comando) o `ctx.reload()` desde un handler; recarga extensiones,
skills, prompts y themes leyendo el source **actual de disco**. Ver el ejemplo
upstream `packages/coding-agent/examples/extensions/reload-runtime.ts` para el
patrón de reload seguro (un tool no puede llamar `ctx.reload()` directo: encola
un follow-up `/reload`).

El riesgo no es de sandbox — es de **topología de instalación**: dónde apunta el
`packages[]` global y cuándo hacés `/reload`. Estrategias, de más a menos segura:

| Estrategia | Cómo | Aislamiento |
|---|---|---|
| **A. Worktree + segunda instancia pi** | `git_worktree open <name>` → nueva sesión pi ahí; `pi install ./ -l` en el worktree | Un edit roto solo afecta esa sesión throwaway; tu sesión de trabajo queda intacta |
| **B. Install project-local en un scratch** | `pi install ./ -l` en un dir de prueba; tu global sigue en la versión estable | La sesión de autoría no depende de tus edits en vuelo |
| **C. `/reload` in-place** | editás + `/reload` en la misma sesión | **Ninguno.** Rápido pero podés cortar tu loop de trabajo. Solo tras `npm test` verde |

**Recomendación:** eje 1 como feedback principal; para smoke en vivo, **estrategia
A** — "desarrollar" y "probar" nunca comparten proceso.

> Regla relacionada: **no hagas busy-poll de un run en background** — el harness
> lo trackea y avisa al terminar. (Ver la guía del tool `dynamic_workflow` y el
> skill `ultracode`.)

## Eje 3 — Aislamiento de ejecución: ¿el código bajo prueba puede dañar el host?

Eje aparte, **opt-in**. Nada que ver con `/reload`: acá aislás la *ejecución* de
tools/`!`-commands, no el ciclo de recarga.

- **Gondolin (micro-VM Linux):** ver [`gondolin-isolation.md`](./gondolin-isolation.md).
  Aísla los tools built-in y `!` en una micro-VM; **no** aísla los subagentes de
  dynamic-workflows (spawnean `pi`/`codex` en el host).
- **Contenedor / Docker:** para aislar el orquestador entero, correr todo `pi`
  dentro de un contenedor (ver `docs/containerization.md` de pi upstream), o usar
  la extensión `pi-container` para correr comandos en micro-VMs de Apple
  `container`.

No uses el eje 3 para resolver el eje 2: un edit roto no es un problema de
seguridad de ejecución, es de cuándo recargás.

## Checklist de referencia

1. Escribí/actualizá el test aislado primero (eje 1, Red).
2. Implementá hasta verde: `node --test <suite>`; refactor con la red de tests.
3. `npm test` completo antes de commitear (gate del repo).
4. Smoke en vivo solo si hace falta, en un worktree aparte (eje 2, estrategia A).
5. Commit atómico con Conventional Commits + scope (ej. `feat(pi-goal): …`).

## Ver también

- [`README.md`](../README.md) — instalación / dogfooding (`pi install ./`, `/reload`).
- Skill `init-pi-dynamic-workflows` — onboarding desde un clon fresco.
- [`.pi/memory/testing.md`](../.pi/memory/testing.md) — detalles del harness de tests.
- [`gondolin-isolation.md`](./gondolin-isolation.md) — aislamiento por micro-VM (eje 3).
