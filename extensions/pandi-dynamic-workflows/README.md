# @pandi-coding-agent/pandi-dynamic-workflows

A JavaScript runtime for multi-agent workflows inside Pi: fan out parallel
subagents, collect artifacts, resume interrupted runs, and watch it all in a
TUI dashboard. Reach for it when a task is too big or too uncertain for a
single reply — a repo-wide audit, a broad migration, or research that needs
independent perspectives — but skip it for a single question or a one-file
edit; a few direct tool calls are cheaper.

## Quickstart

A workflow is a plain JavaScript file: a top-level script (no `import`, no
other exports) that ends with `return <value>`, using injected globals like
`agent` and `args`. Save this as `.pi/workflows/hello.js`:

```js
const input = typeof args === "string" ? JSON.parse(args) : (args ?? {});
const topic = input.topic ?? "pi extensions";
const notes = await agent(`List 3 facts about ${topic}.`, { model: "haiku", effort: "low" });
return await agent(`Turn these notes into one tight paragraph:\n${notes}`, { effort: "high" });
```

Then, from a Pi session:

```text
/workflow run hello {"topic": "circuit breakers"}
```

That's the whole loop: write a `.js` file, `/workflow run <name> [json-input]`.
No UI? Ask the agent to call the `dynamic_workflow` tool with
`action: "write"` (name + code) and `action: "run"` (name + input) instead.

## What you get

- A JavaScript workflow runtime with injected globals: `agent`, `agents`, `pipeline`, `parallel`, `race`, `ask`, `workflow`, `phase`, `log`, `args`, plus read-only `limits`/`runId`/`runDir`/`cwd`.
- The `dynamic_workflow` model tool for listing, scaffolding, reading, writing, running, resuming, cancelling, deleting, graphing, listing runs, and viewing workflows (and more).
- A resumable journal and per-run artifacts, so crashed or cancelled runs continue instead of restarting.
- A live TUI dashboard (`/workflows` or `Ctrl+Alt+W`) with Monitor, Agents, Sessions, Runs, Workflows, Patterns, and Activity tabs.
- Ultracode routing commands and a Contract Gate that reviews the task contract before broad orchestration.
- A compact scaffold catalog: 12 primary scaffolds, 7 compose scaffolds, and 6 use-case scaffolds — no pattern aliases.

## Install

From npm:

```bash
pi install npm:@pandi-coding-agent/pandi-dynamic-workflows
```

From this repository:

```bash
pi install ./extensions/pandi-dynamic-workflows          # global (your user)
pi install -l ./extensions/pandi-dynamic-workflows       # project-local
pi --no-extensions -e ./extensions/pandi-dynamic-workflows   # one-off trial, nothing else loaded
```

## Choosing a primitive

| Situation | Primitive |
| --- | --- |
| One subagent call | `agent(prompt, options?)` |
| Same one step, over many independent items | `agents(items, options?)` |
| 2+ dependent stages per item, no cross-item merge | `pipeline(items, ...stages)` |
| A later step needs ALL results at once (barrier: dedup, rank, merge) | `parallel(thunks)` |
| First accepted answer wins; cancel the rest | `race(thunks, { accept? })` |
| The workflow can't safely decide alone — needs a human call | `ask(question, options?)` |

`race` and `ask` are pi-only (not on the Claude Code Workflow tool). See
`primitives/*.md` for full signatures and gotchas.

## Commands

| Command | What it does |
| --- | --- |
| `/workflow …` | Manage workflows: `new` (scaffold), `run`, `start`, `agents`, `sessions`, `cleanup`, `delete`, `delete-run`, and more. |
| `/workflows` | Open the workflow dashboard (also `Ctrl+Alt+W`). |
| `/dynamic-workflow` (alias `/ultracode`) | Route the current task through the Ultracode workflow router. |
| `/deep-research` | Legacy intent; routes to the `complex-research` pattern. |
| `/ultracode-mode` | Toggle always-on Ultracode routing for the session. |
| `/ultracode-contract` | Toggle the Contract Gate; `/ultracode-contract off` disables it for the session. |
| `dynamic_workflow` | Model tool: list, scaffold, read, write, run, start, resume, cancel, delete, graph, runs, view, and report on workflows (and more). |

`/workflow run <name>` runs in the foreground and prints the result — except
inside a persistent (TUI) session, where it auto-backgrounds so the dashboard
stays the control plane. `/workflow start <name>` launches in the background
when the session is TUI or RPC, so you can keep chatting while it runs; in
print/json mode there is no persistent session to keep it alive, so it errors
instead of falling back to foreground.

## How it works

Stable workflows live in `.pi/workflows/`; drafts and run artifacts live under
`.pi/workflows/drafts/` and `.pi/workflows/runs/` in trusted projects. A
workflow may optionally declare `export const meta = { name, description,
phases }` for dashboard labels. Key primitives beyond the table above:

- `ask(question, opts?)` — pause a branch to ask a human via Pi's UI (`input`/`confirm`/`select`). Resume-safe (the answer is journaled and replayed, never re-asked), headless-honest (`opts.default` or a clear error, never hangs), and cancellable inside `race()`.
- `race(thunks, { accept? })` — first accepted branch wins; in-flight losers are cancelled with a real SIGTERM via each thunk's `AbortSignal`. Returns `{ winner, index, status }`.
- **Per-call model and reasoning:** every subagent call can set its own `model`, `provider`, and `effort` (`low|medium|high|xhigh|max`). Omitting them inherits the orchestrator's model and session reasoning level. They are part of the cache key, so changing them re-runs that call on resume.

```js
// Decide model + reasoning per call.
const notes = await agents(files.map((f) => ({
  label: `scout-${f}`, prompt: `Summarize risks in ${f}.`,
  model: "haiku", effort: "low", tools: ["read", "grep", "find", "ls"],
})), { concurrency: 8 });
const verdict = await agent(
  `Synthesize a ranked, evidence-backed verdict.\n\n${compact(notes, 50000)}`,
  { label: "synthesis", model: "sonnet", effort: "high" },
);
```

Prompt-design rules baked into the scaffolds:

- **Stable KV-cache prefix.** Put the shared framing (role, task, success criteria, output format) first and the volatile per-item content last, so identical prefixes reuse the provider prompt/KV cache. Avoid `Date.now()`/`Math.random()` inside prompts — they bust that cache and make the resume journal miss, re-running the call.
- **Position-aware synthesis.** Models attend best to the start and end of context and worst to the middle (the *lost-in-the-middle* U-curve; see `docs/research/2026-06-28-context-engineering-focus.md`). Synthesis scaffolds restate the task and criteria AFTER the evidence block, with a short footer asking for the output format, most-important-first ordering, and explicit notes on failed/empty branches. Replicate this in your own workflows: task/criteria at both ends, evidence in the middle.

When always-on routing is enabled, the prompt's top border embeds an `ultracode auto` label (border color only, plain borders only, so scroll hints like `↑ N more` stay untouched), and the status line shows `uc:auto`/`uc:off` for routing and `cg:on`/`cg:off` for the Contract Gate.

## Limitations & safety notes

The runtime bounds execution at several layers so a workflow cannot grow without control:

- **`maxAgents`** — cap on subagents per run (across all phases, not just peak parallelism); clamped to `limits.maxAgents`.
- **`concurrency`** — simultaneous subagents; clamped to `limits.concurrency`.
- **Depth-1 composition** — `workflow(name, args)` invokes reusable sub-workflows one level deep only; deeper recursive calls are refused.
- **Cross-process recursion guard** — each subagent is spawned one level deeper (`PI_DYNAMIC_WORKFLOWS_DEPTH` = depth + 1). If a subagent with `includeExtensions: true` has the `dynamic_workflow` tool, its `start`/`run`/`resume` actions are **refused** once its depth reaches the limit. This closes the vector where a subagent would launch nested top-level runs that do not count against the parent's budget.
- Runs still execute in untrusted projects, but their artifacts are redirected to a global, project-hashed root instead of `.pi/workflows/runs/`. Only writing drafts/workflows with `scope=project` requires a **trusted project** (use `scope=global` to write without trust).

## Details

### Environment variables

| Variable | Meaning |
| --- | --- |
| `PI_DYNAMIC_WORKFLOWS_DEPTH` | Nesting depth of the current session (`0` at top-level Pi). Set by the runtime when spawning each subagent; you never set it by hand. |
| `PI_DYNAMIC_WORKFLOWS_MAX_DEPTH` | Limit before `start`/`run`/`resume` is refused (default **`2`**, allowing up to two nesting levels). Raise it to allow more nesting; **`0` disables all runs** (including top-level) — useful as a kill-switch. |

### Monitor and dashboard

Open the dashboard with `/workflows` or `Ctrl+Alt+W`. From an **empty** editor, `↓` opens the Monitor and `←` opens Sessions (with a written prompt, `↓`/`←` remain normal cursor movement). `/workflow agents` and `/workflow sessions` open those tabs directly, and the idle status line shows `wf · /workflows` as an entry point.

Keyboard summary (`?` opens the full help overlay):

- **Tabs:** `Tab`/`→` next, `Shift+Tab`/`←` previous; direct jumps `m` Monitor · `A`/`n` Agents · `a` Activity · `s` Sessions · `w` Workflows · `p` Patterns · `R` Runs.
- **Lists:** `↑`/`↓` or `k`/`j`; `PgUp`/`PgDn` page; `Home`/`End` or `G` first/last.
- **Actions:** `Enter`/`o` agent detail — a sub-tabbed screen (**Card · Prompt · Output · Definition · Run · Graph**; switch with `←`/`→`, `Tab`, or `1`–`6`, scroll position remembered per tab) · `v` view run · `g` graph · `c`/`x` cancel active run · `r` rerun · `d`/`Del` delete run (with confirmation). In **Agents**, `f` jumps to the next `failed` agent.
- **Monitor:** with several active runs, `[` and `]` switch the focused run (`Active runs (N)` list on top and a `run k/N` title). The header shows `updated Ns ago` on each refresh, or `⚠ refresh failed: …` on failure.
- **Live agent viewer:** `↑↓`/`PgUp`/`PgDn`/`Home`/`End` to scroll; the header says `refresh 1s` while running and `final (<state>)` when done (polling stops there). `q`/`Esc` closes.

The top help only advertises actions valid for the selected run (for example, no `cancel` when the run is not active). Destructive actions (cancel, delete, rerun, switch session) ask for confirmation.

### Scaffold catalog

Before writing a workflow, use `dynamic_workflow action=scaffold` or `/workflow new <name> --pattern=<key>` to inspect the closest scaffold. Scaffolds are design pieces: pick the simplest one that produces evidence, record limits/caps, and leave verifiable artifacts. Do not use Dynamic Workflows for a simple question, a single-file edit, or a task that fits in a few direct tool calls. Legacy intents remain as routes: `deep-research` → `complex-research`, `default` → `fan-out-and-synthesize`.

| Scaffold | Use it for | Choose it when |
| --- | --- | --- |
| `scout-fanout` | Cheap classification, then per-class treatment. | An audit, PR review, or migration should spend expensive agents only on medium/high-risk files. Verify: full classification artifact, skipped-item counts, evidence per follow-up. |
| `fan-out-and-synthesize` | Independent work with one final reduction. | You can split by files, topics, modules, or perspectives and need a synthesis that drops unsupported findings. Verify: coverage, failed branches, caps, cited findings. |
| `adversarial-verify` | Pruning claims, suspected bugs, or plans before acting. | The cost of accepting a false positive is high. Verify: each claim ends `verified` or `dropped` with a reason and evidence. |
| `judge-escalate` | Designing several solutions and choosing by an explicit rubric. | You need best-of-N for architecture, prompts, or strategy. Verify: candidates, rubric, scores, and drop reasons are saved. |
| `tournament` | Pairwise comparisons and bracket ranking. | Designs, prompts, or plans must compete head-to-head and relative ranking beats absolute scores. Verify: bracket/matrix, criteria, winner rationale. |
| `loop-until-dry` | Discovery or repair of unknown size. | You must iterate until quiet rounds, `maxRounds`, budget, or timeout. Verify: round log, stop criterion, deduplicated findings. |
| `composition-driver` | Local discovery composed with a stable verification library. | No human decision is needed between discovering and verifying. Verify: serializable JSON contract between parent and child, artifacts from both. |
| `verify-claims-lib` | Shared sub-workflow for fact-checking / claim pruning. | Several workflows need the same verification without copying prompts. Verify: `{ claims, skeptics? }` input, stable output, explicit failure handling. |
| `workflow-factory` | Meta-workflow that designs a task-specific workflow. | Orchestration is complex enough that prompts/contracts deserve review before spending many subagents. Verify: draft under `.pi/workflows/drafts/`, review, decision artifacts. |
| `repo-bug-hunt` | Finding likely bugs across many files. | You want a reusable broad audit, not a manual one-off. Verify: file coverage, prioritized findings, file/line citations. |
| `large-migration` | Planning or executing migrations across many files. | You must discover blockers, risks, and caps before editing. Verify: candidate inventory, risk classification, migration checklist. |
| `complex-research` | Broad research with sources, comparisons, or migration analysis. | You need independent perspectives and citations, not a quick answer. Verify: sources per claim, angle coverage, research limits. |
| `adversarial-plan-review` | A skeptical panel before implementing a risky decision. | A plan needs critique from several perspectives. Verify: accepted risks, recommended changes, verification gaps. |
| `bug-verify` | Confirming sweep findings before reporting or changing code. | You have suspected bugs/claims and want to separate real evidence from hallucinations. Verify: each finding has a repro, concrete evidence, or a drop reason. |

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

## Related

- For `/effort ultracode`, also install `./extensions/pandi-effort`.
- For the full bundle of extensions and skills, install the repository root instead.
