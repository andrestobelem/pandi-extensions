# pi-dynamic-workflows

**A suite of 17 extensions for [Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)** — the `@earendil-works/pi-coding-agent` agentic coding CLI — that brings Claude Code's ergonomics and capabilities to Pi: **dynamic multi-agent workflows** (the centerpiece), plus `/loop`, `/goal`, `/plan`, local memory, context auto-compaction, TypeScript diagnostics, git worktrees, Linux sandboxes, and several UX aliases/shortcuts.

The heart of the repo is **Dynamic Workflows / Ultracode**: trusted JavaScript scripts that Pi executes to orchestrate parallel subagents, persist artifacts outside the chat context, and return a coordinated synthesis. The other extensions are independent pieces you can install one by one or all together.

- **License:** MIT · **Repo:** <https://github.com/andrestobelem/pi-dynamic-workflows>
- **Minimum requirements:** Node.js ≥ 22.19.0 + the Pi CLI + git. Full requirements and optional capabilities: [`docs/setup.md`](docs/setup.md).

## Quickstart

```bash
# 0. Node >= 22.19.0 (nvm recommended; the repo ships .nvmrc)
nvm install && nvm use

# 1. Install the Pi runtime globally
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
pi --version

# 2. Clone and install the dev toolchain
git clone https://github.com/andrestobelem/pi-dynamic-workflows.git
cd pi-dynamic-workflows
npm install

# 3. Check your environment, then run the full gate
npm run doctor
npm test

# 4. Install ALL extensions + skills into Pi (global for your user)
pi install ./                       # project-local: pi install -l ./

# 5. Open Pi in your project, trust it, and smoke test
cd /your/project && pi
#   inside Pi:  /trust  then  /reload
#   /effort status      (ultracode router)
#   /workflows          (TUI dashboard)  or  /workflow patterns
```

Optional extras (web search for subagents, Context7 docs, PNG graphs, Apple `container` sandboxes, Gondolin micro-VMs) and the external `karpathy-guidelines` skill are covered in [`docs/setup.md`](docs/setup.md).

## Extension catalog

All 20 extensions load by default from the `pi.extensions` field of `package.json` when you run `pi install ./`. Each one is also installable on its own with `pi install ./extensions/<name>`.

| Extension | Surface (human · model) | What it does | Extra requirements |
| --- | --- | --- | --- |
| **pi-dynamic-workflows** (core) | `/workflow`, `/workflows`, `/ultracode`, `/dynamic-workflow`, `/deep-research`, `/ultracode-mode`, `/ultracode-contract` · `dynamic_workflow` | JS workflow runtime for multi-agent orchestration with parallel execution, artifacts, and idempotent resume. | optional: mmdc, web_search, Context7 |
| **pi-loop** | `/loop` · `loop_schedule`, `loop_stop` | Iterative loop with dynamic or fixed cadence, driven by the model or the extension. | TUI/RPC; autopilot requires trust |
| **pi-goal** | `/goal` · `goal_progress` | Goal-driven loop with a mandatory completion check and optional independent verifier. | TUI/RPC |
| **pi-plan** | `/plan` · `enter_plan_mode`, `submit_plan` | Read-only plan mode with mutations blocked until you explicitly approve the plan. | TUI/RPC (or `PI_PLAN_NONINTERACTIVE=1`) |
| **pi-effort** | `/effort status\|off\|minimal\|low\|medium\|high\|xhigh\|ultracode` | Claude-style thinking-level switch; `ultracode` enables the workflow router. | `ultracode` needs the core loaded |
| **pi-local-memory** | `remember` | Local memory in `.pi/memory/`: auto-injected index + on-demand topic files. | ⚠ auto-injects memory: trusted projects only |
| **pi-auto-compact** | `/auto-compact [bar\|snapshot\|snapshots\|clear-tools]` | Auto-compacts context past a threshold, with recoverable snapshots and a progress bar. | configurable via `PI_AUTO_COMPACT_*` |
| **pi-typescript-lsp** | `/tsc` · `typescript_diagnostics` | `tsc --noEmit` feedback scoped to the files touched this turn; non-blocking. | project `tsconfig.json` |
| **pi-worktree** | `/worktree` · `git_worktree` | Manages git worktrees from Pi; opens new sessions, never changes the cwd. | git + a git repo |
| **pi-container** | `/container` · `container_sandbox` | Runs isolated Linux commands in Apple `container` micro-VMs, without touching the host. | macOS Apple Silicon + `container` |
| **pi-bg** | `/bg` | In-memory background jobs for one-off human commands; not resumable (the small sibling of `dynamic_workflow`). | trust for `start` |
| **pi-mdview** | `/mdview` | Opens a Markdown file in Pi's scrollable TUI viewer. | — |
| **pi-mdhtml** | `/mdhtml` · `markdown_to_html` | Converts Markdown into pandi-styled self-contained HTML artifacts (light + dark). | — |
| **pi-btw** | `/btw` | Quick side question about the current conversation, tool-free, in an overlay; not saved to history. | — |
| **pi-rename** | `/rename` | Renames the session or auto-generates the name from history (Claude-style). | optional: `PI_RENAME_*` |
| **pi-pandi** | `/pandi [art\|face\|off\|on]` | Panda character: animated splash, indicator, verbs, and mood. | TUI for the full effect |
| **pi-exit** | `/exit` | Claude-style alias of `/quit` for a clean exit. | — |
| **pi-clear** | `/clear` | Claude-style alias of `/new` to start a fresh session. | — |
| **pi-ask** | · `ask_choice`, `ask_confirm` | Interactive TUI selector/confirm tools for model-driven decision points. | TUI/RPC |
| **pi-doctor** | `/doctor` | Runs the repo's read-only environment check (`scripts/doctor.mjs`) and shows the report. | — |

> `extensions/shared/` is not an extension: it is test-harness code, never published or loaded. `extensions/pi-pandi-theme/` ships no code either: it is a themes-only package (`pi.themes`) with the `panda-syntax-dark`/`panda-syntax-light` variants, the visual companion of **pi-pandi**; it loads with `pi install ./` and is enabled via `/settings` or `"theme"`.

## Dynamic Workflows in 60 seconds

A Dynamic Workflow is a **trusted JavaScript script** that Pi runs to orchestrate big work with subagents — mentally, a **MapReduce with agents**: scout the real work-list cheaply, fan out independent branches with evidence contracts, persist artifacts outside the chat, and let a final synthesis-as-judge deduplicate and prioritize.

```js
export default async function main() {
  const items = [
    { label: "a", prompt: "Review src/a.ts", tools: ["read", "grep", "find", "ls"], agentType: "reviewer" },
    { label: "b", prompt: "Review src/b.ts", tools: ["read", "grep", "find", "ls"], agentType: "reviewer" },
  ];
  const reviews = await agents(items, { concurrency: 2, settle: true });
  await writeArtifact("reviews.json", reviews);
  return compact(reviews.filter(Boolean), 20000);
}
```

Key points:

- **Injected globals, no imports**: `agent`/`agents`, `pipeline`, `parallel`, `race`, `ask`, `workflow`, `bash`, `readFile`/`writeArtifact`, `log`, `compact`, plus read-only `args` and `limits`.
- **Personas**: `agentType: "explore" | "reviewer" | "planner" | "architect" | "implementer" | "researcher"` applies role defaults (all read-only by default); explicit options win.
- **Background by default** in TUI/RPC sessions, with a live dashboard (`/workflows`) and per-run artifacts under `.pi/workflows/runs/<run-id>/`.
- **Idempotent resume**: completed `agent()` calls are journaled and never re-run; `/workflow resume <runId>` continues an interrupted run in place.
- **Ultracode always-on**: a Claude Code-style router that weighs, per substantive task, whether to answer inline or orchestrate a workflow (`/effort ultracode`, `/ultracode-mode`).

Full guide — execution cycle, complete API, concurrency, resume journal, pattern catalog, security: [`docs/dynamic-workflows.md`](docs/dynamic-workflows.md).

### Research-backed templates

Map common agent papers/frameworks to Pi workflow design:

- **ReAct** -> scout/observe with tools before fan-out; keep reasoning tied to evidence.
- **Self-consistency** -> sample independent branches, then select by consistency/evidence rather than trusting one path.
- **Reflexion / Self-Refine** -> generate -> critique -> refine loops, always bounded by rounds, quiet stops, `maxAgents`, and timeout.
- **Tree of Thoughts** -> branch alternatives, evaluate/prune with a judge, then commit to one path.
- **Multiagent debate** -> adversarial reviewers plus synthesis-as-judge; unsupported claims are dropped.
- **AutoGen / CAMEL / MetaGPT** -> explicit roles, stable artifacts, and clear handoff contracts.
- **SWE-agent / DSPy** -> interface and contracts matter: narrow tools, schemas/fixed formats, and reproducible checks.

Use these as patterns, not ceremony: every branch needs a reason, a contract, and a stop condition.

## Everyday commands

```text
/workflows                              # TUI dashboard (Monitor/Agents/Sessions/Runs/Workflows/Patterns/Activity)
/workflow run bug-hunt {"maxFiles":40,"concurrency":6,"maxAgents":16}
/workflow view latest                   # timeline + artifacts of the latest run
/workflow resume latest                 # resume an interrupted run without re-running finished agents
/ultracode audit the whole repo for concurrency bugs
/deep-research research options to migrate X to Y
/effort ultracode                       # xhigh thinking + Claude-style workflow router
/plan                                   # read-only plan mode, mutations blocked until approval
/loop fix the failing tests             # iterative loop with dynamic cadence
/goal make npm test pass                # goal loop with independent verification
/bg start npm test                      # one-off human background job (see extensions/pi-bg/README.md)
```

Some extensions also expose tools that **Pi decides to use on its own** (not human slash commands): `enter_plan_mode`/`submit_plan` (plan before risky changes; only you approve), `remember` (persist durable notes under `.pi/memory/`), `git_worktree`, `container_sandbox`, `typescript_diagnostics`, `ask_choice`/`ask_confirm`, `loop_schedule`/`loop_stop`, and `goal_progress`. Each extension's README documents its surface.

## Documentation

- [`docs/setup.md`](docs/setup.md) — full requirements, optional capabilities, env-var configuration, distribution channels, repo layout.
- [`docs/dynamic-workflows.md`](docs/dynamic-workflows.md) — the deep Dynamic Workflows guide: execution cycle, globals API, background & resume, concurrency, pattern catalog, prompts, security.
- [`docs/developing-extensions.md`](docs/developing-extensions.md) — developing extensions in this self-hosted repo without breaking your session.
- [`extensions/<name>/README.md`](extensions) — per-extension docs (e.g. [`pi-dynamic-workflows`](extensions/pi-dynamic-workflows/README.md), [`pi-bg`](extensions/pi-bg/README.md)).

## Verification

```bash
npm test
```

The gate runs, in order: `tsc` (typecheck of all extensions), `biome check .` (JS/TS/JSON lint + format), `markdownlint-cli2` (Markdown), and the colocated integration suites via `scripts/test/run-all.mjs`. Check your environment first with `npm run doctor`.

## Issue tracking

Work is tracked in the GitHub Project **[pi-dynamic-workflows](https://github.com/users/andrestobelem/projects/4)** (v2 board).

- Stories, tasks, and bugs are repo [Issues](https://github.com/andrestobelem/pi-dynamic-workflows/issues), labelled `story` / `task` / `bug` / `tests` / `tech-debt`.
- The board groups them by **Status** (Todo / In Progress / Done); a parent story links its sub-tasks in the body.
- Finishing work? Put `Closes #N` in the commit so the issue and its board card close automatically.
- Managed from the terminal with the [`gh`](https://cli.github.com/) CLI (e.g. `gh issue create`, `gh project item-add 4 --owner andrestobelem`).

## License

MIT — see [`LICENSE`](./LICENSE).
