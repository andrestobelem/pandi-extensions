---
name: init-pandi-extensions
description:
  Inicializá `pandi-extensions` cuando haya que preparar un clon nuevo para Pi o Claude Code, desarrollar extensiones
  con el perfil aislado de Picante, reparar drift detectado por `doctor` o habilitar integraciones opcionales.
---

# Inicializar este harness (`pandi-extensions`)

## En 30 segundos

1. Parate en el **repo root**, instalá Node vía `nvm` y elegí un camino.
2. **Desarrollo con Picante:** cloná `pi-cante` como sibling e instalá las dependencias de ambos repos.
3. Verificá ese perfil con `npm run dev:picante -- status`, `npm run smoke:picante` y `npm run dev:picante`.
4. **Consumo con Pi vanilla:** instalá la CLI global de Pi, las dependencias del repo y el bundle con `pi install ./`.
5. Verificá con `npm test`; en el proyecto destino vanilla, hacé `/trust` + `/reload`.

## Alcance y fuentes

Llevá un **fresh clone** de `pandi-extensions` a una instalación usable: las extensiones de Pi (`/workflow`, `/goal`,
`/loop`, `/plan`, `/effort`, `/mdview`, …), las skills del proyecto y el catálogo de `dynamic_workflow`, disponibles
tanto desde Pi como desde Claude Code.

**Fuente de verdad:** la sección **"Quickstart"** del README, `docs/setup.md` para capacidades opcionales y
`extensions/pandi-doctor/scripts/doctor.mjs`. Esta skill aporta el procedimiento ordenado y el criterio. Si dudás, corré
`npm run doctor` y seguí README + docs en vez de adivinar. Leé versiones y pasos de `.nvmrc`, `package.json`, el README
y `docs/setup.md`.

## Precondiciones para chequear primero (solo lectura)

1. ¿Estamos en el **repo root**? (`package.json` debe tener `name: pandi-extensions`.)
2. Elegí el host antes de instalar nada:
   - **Desarrollo con Picante:** no hace falta una CLI ni una suite global. Usá el wrapper aislado de este repo.
   - **Consumo con Pi vanilla:** corré **`npm run doctor`**. Es read-only y lista los requisitos del perfil vanilla.
3. Anotá la plataforma: los comandos de instalación cambian (`macOS` = `brew`, Linux = package manager de la distro; los
   sandboxes Apple `container` son solo para macOS Apple Silicon).

## Instalación ordenada (elegí una rama)

### Desarrollo con Picante

Usá esta rama para modificar el checkout. No instala Pi ni extensiones en perfiles reales:

```bash
# 0. Node >= 22.19.0 (el repo fija el major en .nvmrc)
nvm install && nvm use

# 1. Dependencias de ambos checkouts sibling
npm install
(cd ../pi-cante && npm install --ignore-scripts)

# 2. Perfil descartable + smokes sin modelo
npm run dev:picante -- status
npm run smoke:picante
npm run smoke:picante:tui

# 3. Gate completo y TUI interactiva contra este checkout
npm test
npm run dev:picante
```

Si los repos no son siblings, definí `PI_CANTE_ROOT=/ruta/a/pi-cante`. Picante registra la suite con alcance de usuario
solo dentro de `pi-cante/.pandi-dev/agent`; el workspace real usa `.pi-cante/` project-local. No ejecutes `pi install
./` ni instales Pi globalmente para esta rama.

**Cierre Picante:** `status` muestra el agent descartable y una sola fuente local; ambos smokes y `npm test` terminan
con exit 0; la TUI abre este checkout.

### Consumo con Pi vanilla

Usá esta rama únicamente para dejar la suite disponible en un perfil normal de Pi:

```bash
# 0. Node y toolchain del checkout
nvm install && nvm use
npm install

# 1. Runtime global de Pi
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
pi --version

# 2. Verificación y gate
npm run doctor
npm test

# 3. Suite para el usuario vanilla (alternativa project-local: pi install -l ./)
pi install ./
```

**Cierre vanilla:** `pi --version` responde, `npm run doctor` no reporta faltantes MANDATORY, `npm test` y `pi install
./` terminan con exit 0.

Si `doctor` reporta drift repo-local, corré el fix que imprime. La sincronización global de Claude es opcional: no la
instales para resolver un warning salvo que el usuario haya elegido explícitamente ese alcance.

Arreglos de sync comunes:

```bash
npm run sync:claude:global:status # inspección read-only; respeta CLAUDE_GLOBAL_DIR
npm run sync:claude:global:install # opt-in: instala y registra archivos gestionados en ~/.claude
npm run sync:claude:global:remove # elimina solo managed sin cambios; conserva ajenos/modificados
npm run sync:manifest             # package.json#pi desde extension manifests
npm run sync:settings             # .pi/settings*.json desde extension manifests
npm run sync:skills               # mirror .pi/skills -> .claude/skills
npm run sync:skills:vendor        # .pi/skills -> copias vendorizadas de extension skills
npm run sync:agents               # AGENTS.md -> CLAUDE.md
npm run sync:claude:ultracode     # Claude ultracode skills generadas
npm run sync:scaffold-catalog     # prosa del catálogo ES → scaffold-catalog + README
npm run sync:docs:html            # mirror generado de docs/html
npm run sync:personas             # README/HTML generados de personas
```

Qué skill editar y en qué orden correr los sync:
[`docs/handbooks/glosario-skills.md`](../../../docs/handbooks/glosario-skills.md) (sección _Capas de generación y
sync_).

Después de la rama **Pi vanilla**, en el proyecto donde las quieras usar:

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

También son buenas señales: `/doctor` in-session (o `npm run doctor` antes de instalar) en verde para los requisitos
obligatorios y `npm test` pasando.

**Cierre de smoke:** con Picante pasan los dos smokes del wrapper. Con Pi vanilla, después de `/trust` + `/reload`,
`/doctor` no reporta faltantes obligatorios y `/effort status` + `/workflows` están disponibles.

## Trabajar DENTRO de este repo (sin instalación)

El loop recomendado usa el checkout sibling de `pi-cante`:

```bash
npm run dev:picante -- status
npm run smoke:picante
npm run smoke:picante:tui
npm run dev:picante
```

Picante registra este checkout con alcance de usuario solo dentro de `.pandi-dev/agent`, abre la TUI con este repo como
cwd real y reserva el proyecto scratch para los smokes. No toca perfiles reales; el estado del workspace vive en
`.pi-cante/` (gitignored).

Como validación separada y opt-in de compatibilidad, este checkout también cablea cada extensión para Pi vanilla
mediante `.pi/settings.json` (`packages: [...]`). Solo si elegiste esa rama, corré `pi` en el repo root y hacé `/trust`.
`pi install ./` deja las extensiones disponibles en otros proyectos del perfil vanilla; no forma parte del loop
Picante.

Para probar una extensión sin instalarla:

- `pi --no-extensions -e ./extensions/pandi-dynamic-workflows/index.ts`
- `pi --no-extensions -e .` para el bundle completo

Como este checkout es **self-hosted** (Picante apunta al repo y carga TypeScript desde disco), un `/reload` aplica tus
cambios sin commitear al instante, y una edición rota puede matar tu sesión. Para el loop completo de desarrollo y
prueba (tests aislados primero, smoke en vivo en otra instancia y cuándo usar sandboxing), ver
[`docs/developing-extensions.md`](../../../docs/developing-extensions.md).

### Pi dentro de un repo worktree

En un worktree de este repo, primero probá `pi` a secas. Si arranca limpio, no hace falta wrapper.

Si al arrancar aparecen conflictos por tools duplicadas (`dynamic_workflow`, `loop_schedule`, `goal_progress`, etc.), Pi
está cargando ambas cosas:

1. el checkout principal instalado globalmente desde `~/.pi/agent/settings.json`, y
2. los paquetes del proyecto worktree desde el `.pi/settings.json` de ese worktree.

En ese caso, usá en el worktree un wrapper ignorado por git que apunte Pi a un agent dir aislado cuya configuración
omita el paquete del checkout global, pero conserve globals no conflictivos como `npm:pi-codex-web-search`:

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
[multica-ai/andrej-karpathy-skills](https://github.com/multica-ai/andrej-karpathy-skills)). Este repo **no** la
vendorea. No hace falta instalarla globalmente para el loop aislado de Picante. Solo si el usuario elige compartirla
con hosts vanilla, bajala a sus skill dirs globales (Pi lee `~/.agents/skills/`; Claude Code lee
`~/.claude/skills/`):

```bash
for d in ~/.agents/skills ~/.claude/skills; do
  mkdir -p "$d/karpathy-guidelines"
  curl -fsSL https://raw.githubusercontent.com/multica-ai/andrej-karpathy-skills/main/skills/karpathy-guidelines/SKILL.md \
    -o "$d/karpathy-guidelines/SKILL.md"
done
```

En Claude Code también podés usar el plugin upstream: `/plugin marketplace add multica-ai/andrej-karpathy-skills` y
luego `/plugin install andrej-karpathy-skills`. `npm run doctor` reporta si la skill está presente.

## Capacidades opcionales (instalá solo si te lo piden o hace falta)

Mirá `npm run doctor`, verificá qué falta y luego:

`pi-codex-web-search` y `pi-mcp-adapter` ya viajan en el bundle completo y en Picante; no los instales globalmente.

```bash
# CLI externa requerida por web_search (instalación de sistema opt-in)
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

Las instalaciones vanilla por extensión (en vez del bundle completo) están en la tabla "Paquetes individuales por
extensión" del README, por ejemplo `pi install ./extensions/pandi-loop`.

## Resolución de problemas

- **Un comando no aparece después de instalar** → abrí Pi en el proyecto destino, hacé `/trust` y luego `/reload` (o
  reiniciá). Los workflows project-scope necesitan trust.
- **`pi` not found** → el paso 1 no terminó o el bin global de npm no está en `PATH`.
- **Node demasiado viejo** → `nvm use` (debe ser ≥ 22.19.0; Gondolin ≥ 23.6.0). El gate es `npm run doctor`, que sale
  non-zero con Node viejo; el repo no declara `engines`, así que `npm install` no bloquea.
- **Algo sigue sin estar claro** → volvé a correr `npm run doctor` y releé "Quickstart" en el README; tomalos como
  autoridad por encima de este resumen.
