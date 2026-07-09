---
name: init-pandi-extensions
description: >-
  Usar cuando alguien acaba de CLONAR este repo `pandi-extensions` y quiere instalarlo,
  configurarlo o hacer onboarding; es decir, dejar funcionando desde cero las extensiones,
  skills y dynamic workflows de Pi (o Claude Code). Recorre la instalación ordenada,
  consciente de la plataforma e idempotente: Node >=22.19 vía nvm, la CLI global de Pi,
  npm install, npm run doctor, npm test, pi install ./, luego /trust + /reload y un smoke
  test. También cubre sync drift reportado por doctor (incluido ~/.claude) y extras
  opcionales de web_search / Context7 / PNG-graph / sandbox. NO para crear extensiones
  nuevas ni para un `npm install` genérico de paquetes no relacionados.
---

# Inicializar este harness (`pandi-extensions`)

Llevá un **fresh clone** de `pandi-extensions` a una instalación usable: las extensiones de Pi
(`/workflow`, `/goal`, `/loop`, `/plan`, `/effort`, `/mdview`, …), las skills del proyecto y el
catálogo de `dynamic_workflow`, disponibles tanto desde Pi como desde Claude Code.

**Fuente de verdad:** la sección **"Quickstart"** del README, `docs/setup.md` para capacidades
opcionales y `extensions/pandi-doctor/scripts/doctor.mjs`. Esta skill aporta el procedimiento
ordenado y el criterio. Si dudás, corré `npm run doctor` y seguí README + docs en vez de adivinar.
No inventes versiones ni pasos: leelos de `.nvmrc`, `package.json`, el README y `docs/setup.md`.

## Cuándo usarla

- "Acabo de clonar esto — ¿cómo lo instalo o lo dejo andando?", "haceme el onboarding", "dejame funcionando las extensiones".
- Cuando querés que `/workflow`, `/effort`, `/goal`, etc. queden disponibles en Pi o Claude Code.

No la uses para crear una extensión/skill nueva ni para hacer `npm install` de una librería no relacionada.

## En 30 segundos

1. Parate en el **repo root**.
2. Corré `npm run doctor` para ver qué falta sin tocar nada.
3. Instalá Node vía `nvm`, la CLI global de Pi y las dependencias del repo.
4. Verificá con `npm test`.
5. Instalá el bundle con `pi install ./` y, en el proyecto destino, hacé `/trust` + `/reload`.

## Precondiciones para chequear primero (solo lectura)

1. ¿Estamos en el **repo root**? (`package.json` debe tener `name: pandi-extensions`.)
2. ¿Qué tiene ya el entorno? Corré **`npm run doctor`**: es read-only, lista todos los requisitos
   obligatorios y opcionales, y sale non-zero solo si falta uno MANDATORY. Dejá que su salida guíe
   qué instalar o sincronizar; no reinstales lo que ya está OK.
3. Anotá la plataforma: los comandos de instalación cambian (`macOS` = `brew`, Linux = package
   manager de la distro; los sandboxes Apple `container` son solo para macOS Apple Silicon).

## Instalación ordenada (idempotente: segura de re-ejecutar)

Corré todo desde el **repo root**. Cada paso es un no-op si ya está satisfecho.

```bash
# 0. Node >= 22.19.0 (el repo fija el major en .nvmrc)
nvm install && nvm use            # o: brew install node / distro node >= 22.19

# 1. Runtime global de Pi (lo ÚNICO que se instala globalmente)
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
pi --version

# 2. Toolchain de desarrollo (biome, tsc, esbuild, markdownlint, prettier, ctx7 = devDeps; mmdc = optionalDependency — todo entra con `npm install`, salvo que uses --omit=optional)
npm install

# 3. Verificar el entorno (capacidades obligatorias + opcionales)
npm run doctor

# 4. Gate completo: typecheck + biome + markdownlint + integration tests
npm test

# 5. Instalar TODAS las extensiones + skills en Pi (global para tu usuario)
pi install ./                     # alternativa project-local: pi install -l ./
```

**Cierre de instalación:** `node --version` satisface `.nvmrc`, `pi --version` responde, `npm run doctor` no reporta faltantes MANDATORY, `npm test` termina con exit 0 y `pi install ./` termina con exit 0.

Si `doctor` reporta mirror drift entre repo y global, corré exactamente el fix que imprime y después
volvé a correr `npm run doctor`.

Arreglos de sync comunes:

```bash
npm run sync:claude:global        # archivos gestionados en ~/.claude; respeta CLAUDE_GLOBAL_DIR
npm run sync:manifest             # package.json#pi desde extension manifests
npm run sync:settings             # .pi/settings*.json desde extension manifests
npm run sync:skills               # mirror .pi/skills -> .claude/skills
npm run sync:skills:vendor        # .pi/skills -> copias vendorizadas de extension skills
npm run sync:agents               # AGENTS.md -> CLAUDE.md
npm run sync:claude:ultracode     # Claude ultracode skills generadas
npm run sync:docs:html            # mirror generado de docs/html
npm run sync:personas             # README/HTML generados de personas
```

Después, **en el proyecto donde las quieras usar** (no necesariamente este repo):

```text
cd /your/project && pi
/trust        # trust del proyecto (los .pi/workflows/ project-scope están trust-gated)
/reload       # o reiniciá Pi
```

## Verificar que cargó (smoke test)

Dentro de Pi:

```text
/effort status        # ultracode router presente
/workflows            # dashboard TUI   (o: /workflow patterns)
/doctor               # chequeo del entorno in-session (igual que `npm run doctor`, una vez cargado)
```

También son buenas señales: `/doctor` in-session (o `npm run doctor` antes de instalar) en verde para
los requisitos obligatorios y `npm test` pasando.

**Cierre de smoke:** después de `/trust` + `/reload` en el proyecto destino, `/doctor` no reporta faltantes obligatorios y al menos `/effort status` y `/workflows` están disponibles.

## Trabajar DENTRO de este repo (sin instalación)

Este checkout ya cablea cada extensión mediante su propio `.pi/settings.json` (`packages: [...]`).
Entonces, para hackear el repo, alcanza con correr `pi` en el repo root y hacer `/trust`. `pi install ./`
solo hace falta para dejar las extensiones disponibles en tus OTROS proyectos.

Para probar una extensión sin instalarla:

- `pi --no-extensions -e ./extensions/pandi-dynamic-workflows/index.ts`
- `pi --no-extensions -e .` para el bundle completo

Como este checkout es **self-hosted** (la instalación global puede apuntar de vuelta a este repo y `pi`
carga TypeScript de extensiones desde disco), un `/reload` aplica tus cambios sin commitear al instante,
y una edición rota puede matar tu sesión. Para el loop completo de desarrollo y prueba (tests aislados
primero, smoke en vivo en otro worktree/instancia y cuándo usar sandboxing), ver
[`docs/developing-extensions.md`](../../../docs/developing-extensions.md).

### Pi dentro de un repo worktree

En un worktree de este repo, primero probá `pi` a secas. Si arranca limpio, no hace falta wrapper.

Si al arrancar aparecen conflictos por tools duplicadas (`dynamic_workflow`, `loop_schedule`, `goal_progress`, etc.),
Pi está cargando ambas cosas:

1. el checkout principal instalado globalmente desde `~/.pi/agent/settings.json`, y
2. los paquetes del proyecto worktree desde el `.pi/settings.json` de ese worktree.

En ese caso, usá en el worktree un wrapper ignorado por git que apunte Pi a un agent dir aislado cuya
configuración omita el paquete del checkout global, pero conserve globals no conflictivos como `npm:pi-codex-web-search`:

```bash
# .pi/tmp/pi-refactor.sh
#!/usr/bin/env bash
set -euo pipefail
cd /path/to/worktree
export PI_CODING_AGENT_DIR="$PWD/.pi/agent-refactor"
exec pi --approve "$@"
```

Abrí tabs/splits de Supacode con ese wrapper en vez de `pi` solo cuando aparezca ese conflicto.

## Skill externa: `karpathy-guidelines`

`karpathy-guidelines` es una skill EXTERNA, de la comunidad (de
[multica-ai/andrej-karpathy-skills](https://github.com/multica-ai/andrej-karpathy-skills)). Este repo
**no** la vendorea, pero `AGENTS.md` espera que esté *instalada*. Si `doctor` avisa que falta, bajala a
tus skill dirs globales (Pi lee `~/.agents/skills/`; Claude Code lee `~/.claude/skills/`; idempotente,
seguro de re-ejecutar):

```bash
for d in ~/.agents/skills ~/.claude/skills; do
  mkdir -p "$d/karpathy-guidelines"
  curl -fsSL https://raw.githubusercontent.com/multica-ai/andrej-karpathy-skills/main/skills/karpathy-guidelines/SKILL.md \
    -o "$d/karpathy-guidelines/SKILL.md"
done
```

En Claude Code también podés usar el plugin upstream: `/plugin marketplace add
multica-ai/andrej-karpathy-skills` y luego `/plugin install andrej-karpathy-skills`. `npm run doctor`
reporta si la skill está presente.

## Capacidades opcionales (instalá solo si te lo piden o hace falta)

Mirá `npm run doctor`, verificá qué falta y luego:

```bash
# web_search para subagentes
pi install npm:pi-codex-web-search
brew install codex               # o: npm install -g @openai/codex

# Docs de Context7 para subagentes (ctx7 CLI acá es una devDependency; global también sirve)
npx ctx7 setup --cli

# Gráficos PNG para /workflow graph (si falla el render de mmdc)
npx puppeteer browsers install chrome-headless-shell

# Sandboxes Linux (/container) — solo macOS Apple Silicon
brew install container && container system kernel set --recommended && container system start

# Aislamiento por micro-VM (Gondolin) — Node >= 23.6.0
npm run setup:gondolin && echo "then run:  pi -e .pi/tools/gondolin"
```

Las instalaciones por extensión (en vez del bundle completo) están en la tabla
"Paquetes individuales por extensión" del README, por ejemplo `pi install ./extensions/pandi-loop`.

## Resolución de problemas

- **Un comando no aparece después de instalar** → abrí Pi en el proyecto destino, hacé `/trust` y luego
  `/reload` (o reiniciá). Los workflows project-scope necesitan trust.
- **`pi` not found** → el paso 1 no terminó o el bin global de npm no está en `PATH`.
- **Node demasiado viejo** → `nvm use` (debe ser ≥ 22.19.0; Gondolin ≥ 23.6.0). El gate es `npm run doctor`,
  que sale non-zero con Node viejo; el repo no declara `engines`, así que `npm install` no bloquea.
- **Algo sigue sin estar claro** → volvé a correr `npm run doctor` y releé "Quickstart" en el README;
  tomalos como autoridad por encima de este resumen.
