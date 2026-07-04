# OpenProse ("Prose") — analysis and comparison with Dynamic Workflows

Date: 2026-07-04

## Objective

Understand what OpenProse is (the "programming language for AI sessions" behind
the locally installed `open-prose` skill), how its declarative contract model
works, and how it compares to this repo's imperative dynamic workflows — so we
can borrow what helps and be explicit about the trade-offs.

## Sources reviewed

- **prose.md / openprose.ai** (official site; openprose.ai 301-redirects to
  prose.md) — declarative model, primitives, "Prose Complete" harness list.
  <https://prose.md/>
- **Turing Post — "OpenProse: A Language for Reliable AI Agent Workflows"**
  (guest post by creator Raymond Weitekamp, June 2026) — motivation, receipts,
  ProseScript, honest limitations.
  <https://www.turingpost.com/p/openprose-a-language-for-reliable-agents>
- **DEV Community — "OpenProse: A Programming Language for AI Sessions"**
  (Steven Gonsalvez) — syntax example, Forme contract resolution, debugging
  critique.
  <https://dev.to/stevengonsalvez/openprose-a-programming-language-for-ai-sessions-d84>
- **Sean Weldon — "Recursive Coding Agents" (interview with Raymond
  Weitekamp, 2026-06-27)** — context on recursive/self-hosting usage.
  <https://www.sean-weldon.com/blog/2026-06-27-recursive-coding-agents-raymond-weitekamp-openprose>
- **Local skill** `~/.agents/skills/open-prose/` (v0.15.0, also installed at
  `~/.claude/skills/open-prose/`) — SKILL.md, five load-bearing pieces,
  activation contract.

## What OpenProse is

OpenProse (Raymond Weitekamp, open source) treats an AI session as a
Turing-complete virtual machine. Programs are Markdown files (`*.prose.md`)
with YAML frontmatter; the coding agent itself is the compiler and runtime —
there is no external server or orchestration framework. It runs on any
"Prose Complete" harness: Claude Code, OpenCode, Amp, Codex.

The problem it targets is trust and reuse, not model capability: successful
agent sessions vanish into chat history, forcing developers to babysit agents
instead of replaying proven flows. OpenProse converts those flows into
versionable contracts, and each run leaves an audit trail ("receipts").

## Execution model

- **Declarative contracts.** A unit of work (a *responsibility*) declares
  `### Requires` (preconditions/inputs), `### Ensures`
  (postconditions/outputs), and preferred strategies. There is no explicit
  sequencing: if step A *ensures* what step B *requires*, A runs first;
  independent steps parallelize automatically.
- **Forme** is the semantic dependency-injection container that wires
  responsibilities by matching their contracts.
- **ProseScript** is the optional imperative layer for pinned choreography —
  explicit order, loops, conditionals, retries, and parallel blocks inside a
  `### Execution` block.
- **In-session execution.** Unlike LangChain/CrewAI/AutoGen (external
  orchestration) or BAML/DSPy (external harness), the agent reads the Markdown
  and becomes the VM, spawning subagents and persisting run state under an
  OpenProse root.
- Also supports persistent agents (state across invocations), pipelines, and
  intermediate variables.

Minimal step example (from the DEV article):

```markdown
---
requires: [codebase_analysis]
ensures: [test_plan]
---

Review the codebase analysis and create a comprehensive test plan
covering all edge cases for the authentication module.
```

## Local skill (v0.15.0)

The installed `open-prose` skill documents five load-bearing pieces:

| Piece | File | Role |
|-------|------|------|
| Contract Markdown | `contract-markdown.md` | Human-readable `*.prose.md` source format |
| Forme | `forme.md` | Semantic DI container that wires contracts |
| Prose VM | `prose.md` | Execution engine for responsibilities/functions |
| ProseScript | `prosescript.md` | Imperative layer for `### Execution` blocks |
| Responsibility Runtime | `responsibility-runtime.md` | Standing goals, Reactor, compile/serve doctrine |

Activation: typing `prose ...`, opening a `.prose.md` with `kind:`
frontmatter, or asking for reusable multi-agent orchestration; `prose run` is
an in-session instruction (the agent embodies the VM — no `prose` binary).

## Strengths and limitations

Strengths: portable across harnesses, zero external dependencies, programs
improve for free as models improve, Markdown+YAML is readable and
git-friendly, automatic parallelization from contracts.

Limitations (the creator states them himself): it does **not** turn an LLM
into deterministic infrastructure — runs remain non-deterministic, contracts
must be well designed, and it works best with frontier models. Debugging is
the sharpest trade-off: when the runtime decides execution order, explaining
*why* it ran in that order requires understanding the contract-resolution
algorithm.

## Comparison with this repo's dynamic workflows

| Dimension | OpenProse | pi-dynamic-workflows |
|-----------|-----------|----------------------|
| Paradigm | Declarative contracts (Requires/Ensures) | Imperative JavaScript (`pipeline()`, `parallel()`) |
| Who decides order | Forme (semantic contract matching) | The script, explicitly |
| Escape hatch | ProseScript for pinned choreography | n/a (order is always pinned) |
| Determinism of control flow | Model-resolved, non-deterministic | Deterministic script |
| Observability / debugging | Receipts; order requires understanding resolution | Runs, artifacts, journal; order is readable in code |
| Portability | Any "Prose Complete" harness | Claude Code (Workflow) and pi (`dynamic_workflow`) |

Same goal (reusable multi-agent orchestration), inverse bet: OpenProse
optimizes expressiveness and intent reuse; this repo optimizes deterministic
control flow and inspectable evidence — exactly the property the project
instructions call "observable workflows, inspectable artifacts over hidden
magic".

## Possible next steps

- Read the local examples (`~/.agents/skills/open-prose/examples/`,
  e.g. `session-to-prose`) to see a full responsibility in practice.
- Evaluate whether a Requires/Ensures-style contract header would improve our
  workflow drafts' self-documentation without giving up scripted order.
- Compare `workflow-factory` against OpenProse's session-to-prose flow (both
  convert a successful ad-hoc session into a reusable artifact).
