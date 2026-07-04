# Desarrollar y probar extensiones en pi

Fecha: 2026-07-04

Una extensión de pi es un módulo TypeScript que agrega comandos, tools o
reacciones a eventos del ciclo de vida del agente. Esta guía es la fuente
autoritativa de **cómo escribir una extensión de este repo y probarla a la
vez**, sin romper la sesión con la que estás trabajando. Recurrí a ella cuando
vas a crear una extensión nueva, tocar una existente, o no sabés si conviene un
comando, un tool o un event handler.

## Quickstart: una extensión mínima

Una extensión exporta una función default que recibe `pi: ExtensionAPI`. Podés
probarla sin instalarla, apuntando `pi -e` al archivo:

```typescript
// extensions/pandi-hello/index.ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    if (ctx.hasUI) ctx.ui.notify("pandi-hello cargada", "info");
  });

  pi.registerCommand("hello", {
    description: "Saluda",
    handler: async (args, ctx) => ctx.ui.notify(`Hola ${args || "mundo"}!`, "info"),
  });
}
```

```bash
pi -e ./extensions/pandi-hello/index.ts
```

Cada extensión de este repo vive en su propio `extensions/pandi-<nombre>/index.ts`
(o un único `.ts`) y es **self-contained**: nada de imports runtime cruzados a
otra extensión (`../shared/` solo existe para el harness de tests, nunca para
código que corre en producción — ver `AGENTS.md`). Si dos extensiones necesitan
la misma utilidad chica (un `notify.ts`, un parser de flags), se duplica a
propósito: así cada una se puede instalar sola vía `pi install`.

## ¿Comando, tool o event handler?

Los tres primitivos conviven en la misma extensión; la pregunta es **quién
dispara el código**:

| Primitivo | Quién lo dispara | Usalo cuando | Ejemplo en este repo |
|---|---|---|---|
| **Comando** — `pi.registerCommand("nombre", {...})` | El usuario, tipeando `/nombre` | La acción es explícita y el usuario decide el momento | `/plan`, `/loop`, `/goal` |
| **Tool** — `pi.registerTool({...})` | El LLM, cuando decide que la necesita dentro de un turno | Es una capacidad que el modelo debe poder invocar por su cuenta | `dynamic_workflow` (pandi-dynamic-workflows) |
| **Event handler** — `pi.on("evento", (event, ctx) => ...)` | El runtime de pi, en cada punto del lifecycle | Necesitás reaccionar o interceptar sin que nadie lo pida (bloquear un tool, inyectar contexto, persistir estado) | `pi.on("tool_call")` bloqueando mutaciones en `pandi-plan`/`pandi-loop`; `pi.on("session_before_compact")` en `pandi-auto-compact` |

Ver la referencia completa de eventos y `ExtensionAPI` en el
[`extensions.md`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)
de pi upstream (o `docs/extensions.md` de tu instalación local del paquete).

## Probarla sin romper tu sesión

Una vez que la extensión existe, queda el problema puntual de este repo: es
**auto-hospedado**. La suite está instalada globalmente apuntando al propio
checkout
(`packages: ["../../ws/at/pi-dynamic-workflows"]` en `~/.pi/agent/settings.json`),
y **pi carga el TypeScript de las extensiones desde disco** (no bundlea). Entonces
un `/reload` en tu sesión de trabajo ejecuta tus edits **sin commitear** al
instante — y un error de sintaxis o de carga puede tumbar esa sesión.

La clave para no sufrirlo es separar **tres ejes ortogonales** que se confunden
entre sí. Cada uno se resuelve con una herramienta distinta.

### Eje 1 — Corrección: ¿mi edit funciona?

**Loop primario. Sin riesgo para tu sesión. Es TDD (la vía Farley).**

Los tests de integración **no cargan la extensión en tu sesión**: el harness
compartido (`extensions/shared/test/harness.mjs`) hace un esbuild-bundle de la
extensión a un directorio temporal y la importa dinámicamente con un `ctx`
mockeado. Es aislado y rápido.

```bash
# una suite puntual (segundos) — el loop de desarrollo
node --test extensions/pandi-<ext>/tests/integration/<algo>.test.mjs

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

### Eje 2 — Seguridad de sesión: ¿un edit roto me tumba la sesión?

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
| **A. Worktree + segunda instancia pi** | `git_worktree open <name>` → nueva sesión pi ahí; `pi install -l ./` en el worktree | Un edit roto solo afecta esa sesión throwaway; tu sesión de trabajo queda intacta |
| **B. Install project-local en un scratch** | `pi install -l ./` en un dir de prueba; tu global sigue en la versión estable | La sesión de autoría no depende de tus edits en vuelo |
| **C. `/reload` in-place** | editás + `/reload` en la misma sesión | **Ninguno.** Rápido pero podés cortar tu loop de trabajo. Solo tras `npm test` verde |

**Recomendación:** eje 1 como feedback principal; para smoke en vivo, **estrategia
A** — "desarrollar" y "probar" nunca comparten proceso.

> Regla relacionada: **no hagas busy-poll de un run en background** — el harness
> lo trackea y avisa al terminar. (Ver la guía del tool `dynamic_workflow` y el
> skill `ultracode`.)

### Eje 3 — Aislamiento de ejecución: ¿el código bajo prueba puede dañar el host?

Eje aparte, **opt-in**. Nada que ver con `/reload`: acá aislás la *ejecución* de
tools/`!`-commands, no el ciclo de recarga.

- **Gondolin (micro-VM Linux):** ver [`gondolin-isolation.md`](./gondolin-isolation.md).
  Aísla los tools built-in y `!` en una micro-VM; **no** aísla los subagentes de
  dynamic-workflows (spawnean `pi`/`codex` en el host).
- **Contenedor / Docker:** para aislar el orquestador entero, correr todo `pi`
  dentro de un contenedor (ver `docs/containerization.md` de pi upstream), o usar
  la extensión `pandi-container` para correr comandos en micro-VMs de Apple
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
- [`README.md#verification`](../README.md#verification) — cómo correr `npm test` (harness de tests, lint, typecheck).
- [`gondolin-isolation.md`](./gondolin-isolation.md) — aislamiento por micro-VM (eje 3).
