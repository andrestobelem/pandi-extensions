---
name: installing-pi-dynamic-workflows
description: >-
  Use when someone has freshly CLONED this pi-dynamic-workflows repo and wants to install it,
  set it up, or onboard — i.e. get the Pi (or Claude Code) extensions, skills, and dynamic
  workflows working from scratch. Walks the ordered, platform-aware, idempotent setup: Node
  >=22.19 via nvm, the global Pi CLI, npm install, npm run doctor, npm test, pi install ./,
  then /trust + /reload and a smoke test, plus optional web_search / PNG-graph / sandbox extras.
  NOT for authoring new extensions, nor for a generic `npm install` of unrelated packages.
---

# Installing this harness (pi-dynamic-workflows)

Bring a **fresh clone** of `pi-dynamic-workflows` to a working install: the Pi extensions
(`/workflow`, `/goal`, `/loop`, `/plan`, `/effort`, `/mdview`, …), the project skills, and the
dynamic-workflow catalog — usable from Pi and from Claude Code.

**Source of truth:** the README **"Quickstart"** section and `scripts/doctor.mjs`. This skill is the
ordered procedure + judgment; when in doubt, run `npm run doctor` and follow the README rather than
guessing. Do not invent versions or steps — read them from `.nvmrc`, `package.json`, and the README.

## When to use
- "I just cloned this — how do I install/set it up?", "onboard me", "get the extensions working".
- Making the `/workflow`, `/effort`, `/goal`, etc. commands available in Pi (or Claude Code).

Do NOT use for: authoring a new extension/skill, or `npm install`-ing some unrelated library.

## Preconditions to check first (read-only)
1. Are we at the **repo root**? (`package.json` name must be `pi-dynamic-workflows`.)
2. What does the environment already have? Run **`npm run doctor`** — it is read-only, lists every
   mandatory + optional prerequisite, and exits non-zero only if a MANDATORY one is missing. Let its
   output drive what you still need to install; don't reinstall what's already OK.
3. Note the platform: install commands differ (macOS = `brew`, Linux = distro package manager;
   Apple `container` sandboxes are macOS Apple-Silicon only).

## Ordered install (idempotent — safe to re-run)
Run from the **repo root**. Each step is a no-op if already satisfied.

```bash
# 0. Node >= 22.19.0 (the repo pins the major in .nvmrc)
nvm install && nvm use            # or: brew install node / distro node >= 22.19

# 1. Global Pi runtime (the ONLY thing installed globally)
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
pi --version

# 2. Dev toolchain (biome, tsc, esbuild, markdownlint, prettier, ctx7 = devDeps; mmdc = optionalDependency — all pulled by `npm install`, opt out with --omit=optional)
npm install

# 3. Verify the environment (mandatory + optional capabilities)
npm run doctor

# 4. Full gate: typecheck + biome + markdownlint + integration tests
npm test

# 5. Install ALL extensions + skills into Pi (global for your user)
pi install ./                     # project-local instead: pi install -l ./
```

Then, **in the project where you want to use them** (not necessarily this repo):

```text
cd /your/project && pi
/trust        # trust the project (project-scope .pi/workflows/ is trust-gated)
/reload       # or restart Pi
```

## Verify it loaded (smoke test)
Inside Pi:

```text
/effort status        # ultracode router present
/workflows            # the TUI dashboard   (or:  /workflow patterns)
```

Also good signals: `npm run doctor` all-green for mandatory items, and `npm test` passing.

## Working INSIDE this repo (no install needed)
This checkout already wires every extension via its own `.pi/settings.json` (`packages: [...]`).
So to hack on the repo you can just run `pi` at the repo root and `/trust` it — `pi install ./` is
only for making the extensions available in your OTHER projects. To try one extension without
installing: `pi --no-extensions -e ./extensions/pi-dynamic-workflows/index.ts` (or `-e .` for the
whole bundle).

## External skill: karpathy-guidelines (install globally from upstream)
`karpathy-guidelines` is an EXTERNAL, community skill (from
[multica-ai/andrej-karpathy-skills](https://github.com/multica-ai/andrej-karpathy-skills)) — this
repo does **not** vendor it. AGENTS.md expects it *installed*, so drop its `SKILL.md` into your
global skill dirs (idempotent — safe to re-run). Pi reads `~/.agents/skills/`; Claude Code reads
`~/.claude/skills/`:

```bash
for d in ~/.agents/skills ~/.claude/skills; do
  mkdir -p "$d/karpathy-guidelines"
  curl -fsSL https://raw.githubusercontent.com/multica-ai/andrej-karpathy-skills/main/skills/karpathy-guidelines/SKILL.md \
    -o "$d/karpathy-guidelines/SKILL.md"
done
```

(Claude Code users can instead use the upstream plugin: `/plugin marketplace add
multica-ai/andrej-karpathy-skills` then `/plugin install andrej-karpathy-skills`.) `npm run doctor`
reports whether the skill is present.

## Optional capabilities (install only if asked / needed)
Check `npm run doctor` for which are missing, then:

```bash
# web_search for subagents
npm install -g @openai/codex && pi install npm:pi-codex-web-search
# PNG graphs for /workflow graph (if mmdc render fails)
npx puppeteer browsers install chrome-headless-shell
# Linux sandboxes (/container) — macOS Apple Silicon only
brew install container && container system kernel set --recommended && container system start
# micro-VM isolation (Gondolin) — Node >= 23.6.0
npm run setup:gondolin && echo "then run:  pi -e .pi/tools/gondolin"
```

Per-extension installs (instead of the whole bundle) are listed in the README's
"Paquetes individuales por extensión" table, e.g. `pi install ./extensions/pi-loop`.

## Troubleshooting
- **A command isn't available after install** → open Pi in the target project, `/trust`, then
  `/reload` (or restart). Project-scoped workflows need trust.
- **`pi` not found** → step 1 didn't complete or global npm bin isn't on `PATH`.
- **Node too old** → `nvm use` (must be ≥ 22.19.0; Gondolin ≥ 23.6.0). The gate is `npm run doctor`,
  which exits non-zero on old Node; the repo declares no `engines` field, so `npm install` won't block.
- **Anything unclear** → re-run `npm run doctor` and re-read the README "Quickstart"; treat those as
  authoritative over this summary.
