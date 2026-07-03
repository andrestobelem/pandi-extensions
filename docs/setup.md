# Setup — requirements, optional capabilities, configuration, distribution

Full setup reference for the `pi-dynamic-workflows` suite. The root [`README.md`](../README.md) has the condensed quickstart.

## Requirements

### Mandatory

| Requirement | Purpose | Install |
| --- | --- | --- |
| **Node.js ≥ 22.19.0** | Runtime (required by `@earendil-works/pi-coding-agent`; the repo pins `22` in `.nvmrc`). | `nvm install 22 && nvm use 22` — or `brew install node` |
| **Pi CLI** (`@earendil-works/pi-coding-agent`) | Host that loads extensions, TUI/RPC, `pi install`, and the subagent spawner. | `npm install -g --ignore-scripts @earendil-works/pi-coding-agent` (verify with `pi --version`) |
| **npm** | Installs the dev toolchain and runs `npm test`. Ships with Node. | (included with Node) |
| **git** | Used by `pi-worktree` and workflow scouts. | `xcode-select --install` or `brew install git` |

> Node 22 is the floor. The optional Gondolin extension needs Node ≥ 23.6.0.

### Optional (each unlocks one capability; without it, that capability is simply absent)

| Capability | Requirement | Install |
| --- | --- | --- |
| Web search for subagents (`web_search`) | `pi-codex-web-search` extension + `codex` CLI | `pi install npm:pi-codex-web-search` and `brew install codex` (or `npm install -g @openai/codex`) |
| On-demand library docs (Context7) | `context7-cli` skill (optional) + `ctx7` CLI | Configure Context7 with `npx ctx7 setup --cli` ("CLI + Skills" mode; successor of the deprecated `ctx7 skills install`). The `ctx7` CLI is a devDependency: run it with `npx ctx7` after `npm install` (or globally: `npm i -g ctx7@latest`) |
| PNG graphs for `/workflow graph` | `@mermaid-js/mermaid-cli` (`mmdc`) + Puppeteer's Chrome | Installs automatically with `npm install`; if rendering fails: `npx puppeteer browsers install chrome-headless-shell` |
| Linux sandboxes (`pi-container`) | Apple `container` (macOS Apple Silicon) | `brew install container && container system kernel set --recommended && container system start` |
| Micro-VM isolation (Gondolin) | `@earendil-works/gondolin` (darwin-arm64 / linux-x64, Node ≥ 23.6.0) | `npm run setup:gondolin`, then `pi -e .pi/tools/gondolin` |

> The whole dev toolchain (`biome`, `tsc`, `esbuild`, `markdownlint-cli2`, `prettier`, `ctx7`) consists of **devDependencies**; `@mermaid-js/mermaid-cli` is an **optionalDependency** (it has an ASCII fallback, so a failed Chromium download does not break the install). Everything installs with `npm install` (optional ones unless `--omit=optional`) and runs via `npm run …`/`npx`, with no global installation. The only global install is the **Pi CLI**. Verify your environment with `npm run doctor`.

## Installation variants

From this repo, globally for your user:

```bash
pi install ./
```

Local to the current project:

```bash
pi install -l ./
```

Try without installing:

```bash
pi --no-extensions -e ./extensions/pi-dynamic-workflows/index.ts
# or load the whole package:
pi --no-extensions -e .
```

To use project workflows in `.pi/workflows/`, trust the project with `/trust` and restart or run `/reload`.

### External skill: karpathy-guidelines

The `karpathy-guidelines` skill is **not vendored** in the repo; `AGENTS.md` expects it installed. Fetch it from upstream into your global skills (Pi reads `~/.agents/skills`, Claude Code `~/.claude/skills`):

```bash
for d in ~/.agents/skills ~/.claude/skills; do
  mkdir -p "$d/karpathy-guidelines"
  curl -fsSL https://raw.githubusercontent.com/multica-ai/andrej-karpathy-skills/main/skills/karpathy-guidelines/SKILL.md \
    -o "$d/karpathy-guidelines/SKILL.md"
done
```

### Vendored skills

The `pi-dynamic-workflows` package **vendors its own skills** (`ultracode`, `deep-research`, `default`) in `extensions/pi-dynamic-workflows/skills/`, so they travel when installing only that extension. They are a generated mirror of the canonical `.pi/skills/` source (regenerate with `npm run sync:skills:vendor`; the parity test and `npm run doctor` flag drift). In-repo they are not duplicated: that extension's entry in `.pi/settings.json` filters `skills: []` because the repo already loads them via `.pi/skills/` auto-discovery.

## Optional capabilities in detail

- **Web search (`web_search`) for subagents** — install `pi install npm:pi-codex-web-search` (separate package, repo `github.com/ayagmar/pi-codex-web-search`) and the `codex` CLI (`brew install codex` or `npm install -g @openai/codex`). When the runtime finds the extension (in `~/.pi/agent/npm/node_modules/` or `./node_modules/`), it adds `web_search` to every subagent's tool list automatically. If `codex` is not on the PATH, point at it with `CODEX_PATH`. Per-subagent opt-out: `excludeTools: ["web_search"]` or `includeExtensions: false`.
- **Context7 (library docs)** — the `context7-cli` skill is **not** vendored in the repo. Configure it with `npx ctx7 setup --cli` ("CLI + Skills" mode; successor of the deprecated `ctx7 skills install`, which stops working in the next major). Pi auto-discovers the skill from the global scope (`~/.agents/skills/` or `~/.pi/agent/skills/`) in any project and adds it to subagents. The `ctx7` CLI ships as a **devDependency**: run it with `npx ctx7` after `npm install` (or globally with `npm i -g ctx7@latest`). Per-subagent opt-out: `includeSkills: false`.
- **`/workflow graph` visuals** — `mmdc` installs automatically with `npm install` (optionalDependency `@mermaid-js/mermaid-cli`). Inline PNG needs a terminal with an image protocol (Kitty/Ghostty/WezTerm/Warp/iTerm2; Pi disables it under tmux). If `mmdc` fails on Chrome/Puppeteer: `npx puppeteer browsers install chrome-headless-shell`. Without `mmdc`: ASCII topology fallback + Mermaid export.
- **Linux sandboxes (`pi-container`)** — macOS Apple Silicon only: `brew install container && container system kernel set --recommended && container system start`. On unsupported hosts the extension returns a bounded message, it does not crash.
- **Gondolin isolation (micro-VM)** — `npm run setup:gondolin` copies the example shipped with Pi into `.pi/tools/gondolin/` (gitignored, not auto-discovered) and installs its deps with `--ignore-scripts`; load it on demand with `pi -e .pi/tools/gondolin`. Requires darwin-arm64/linux-x64 and Node ≥ 23.6.0. It does not isolate dynamic-workflows subagent spawns (see [`docs/gondolin-isolation.md`](./gondolin-isolation.md)).

## Configuration (environment variables)

All extensions ship sensible defaults; nothing needs configuring to start. To tune behavior, export environment variables — the full list with defaults lives in **`.env.example`**. The most used:

| Variable | Extension | Default | Purpose |
| --- | --- | --- | --- |
| `PI_DYNAMIC_WORKFLOWS_MAX_DEPTH` | core | `2` | Max workflow nesting depth; `0` = full kill-switch. |
| `PI_DYNAMIC_WORKFLOWS_PI_COMMAND` | core, goal | `pi` | Pi binary used to spawn subagents. |
| `PI_AUTO_COMPACT_PERCENT` | auto-compact | `35` | Context % that triggers compaction. |
| `PI_TS_LSP` / `PI_TS_LSP_MODE` | typescript-lsp | `on` / `advisory` | Enables tsc feedback and its mode (`advisory`/`autofix`). |
| `PI_PLAN_NONINTERACTIVE` | plan | (off) | Allows plan mode in print/json (subagents). |
| `CODEX_PATH` | web-search | (PATH) | Path to the `codex` binary when not on the PATH. |

`.env` is gitignored; `.env.example` is committed. This repo does not load `.env` automatically: export the variables in your shell or use `direnv`/`dotenvx`.

## Distribution: channels and the single-identity rule

The suite is distributed through three channels; **pick one per machine/scope** — Pi dedupes packages by identity (npm name / git URL / resolved local path), so two different channels living together load every resource twice (`npm run doctor` detects and warns):

| Channel | How | When |
| --- | --- | --- |
| **Pinned git bundle** | `pi install git:github.com/andrestobelem/pi-dynamic-workflows@v0.2.0` | Consumers: the whole suite, stable version. |
| **Working tree (local paths)** | clone + `pi install ./` (or the per-extension paths) | Development/dogfooding: changes apply with `/reload`. |
| **npm scoped `@pandi-coding-agent/*`** | `pi install npm:@pandi-coding-agent/<ext>` | À la carte per extension — *coming soon* (requires publishing the npm org). |

Every `extensions/pi-<ext>/package.json` already carries its public identity `@pandi-coding-agent/<ext>` (npm workspaces; `npm pack -w @pandi-coding-agent/<ext>` to test the tarball). The root `pi` manifest is **generated** from the sub-packages (`npm run sync:manifest`); a parity test fails on drift. Horizon: **Pandi** as a distro on top of Pi (extensions + theme + persona), not a CLI fork.

## Repository layout (extensions)

Each extension lives as a mini npm package under `extensions/<name>/`:

```text
extensions/<name>/
  index.ts              # Pi entrypoint
  *.ts                  # runtime helpers for that extension
  tests/unit/           # fast tests, where applicable
  tests/integration/    # durable behavior suites
```

`package.json` publishes only runtime files with `files: ["extensions/*/*.ts", ...]`, so tests stay colocated in the repo but out of the npm tarball. `pi.extensions` explicitly lists the entrypoints loaded by default; optional extensions can follow the same convention and be loaded from settings.

`extensions/pi-local-memory/` loads the `.pi/memory/` folder when present (injects the `MEMORY.md` index capped at 200 lines/25 KB and lists topic files for on-demand reading; falls back to the older `.pi/MEMORY.md`). The extension ships with the package; memory content stays private and gitignored.
