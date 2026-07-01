# Agent personas (`agentType`)

A **persona** is a named preset of `AgentOptions` you attach to a subagent with
`agentType: "<name>"`. It sets sensible defaults for `tools`, reasoning
(`thinking`), and a role `systemPrompt`, so you don't re-specify them per call.

Source of truth: `BUILTIN_AGENT_PERSONAS` in
`extensions/pi-dynamic-workflows/agent-env-persona.ts`. Projects can override a
built-in (or add their own) with a trusted `.pi/personas/<name>.json` file whose
keys are limited to the persona-safe `AgentOptions` allowlist.

## Precedence & merge

```
agent({ agentType: "reviewer", model: "…", appendSystemPrompt: "…" })
  → project .pi/personas/reviewer.json  (if present & project trusted)
  ?? BUILTIN_AGENT_PERSONAS["reviewer"]
  → merged with the call's explicit options
```

- **Explicit options always win** over the persona (`{ ...persona, ...options }`).
- **`appendSystemPrompt` is concatenated** (persona base + your text, `\n\n`), not overwritten.
- An unknown `agentType` throws — it is never silently ignored.

## The built-in menu

Every built-in persona defaults to **read-only tools** (`READ_ONLY_AGENT_TOOLS`):
inspect, cite, and propose — never edit. This is a deliberate security invariant.
If a step must write/execute, grant tools explicitly on that call (the explicit
`tools` override wins), or don't use a persona for it.

| `agentType` | reasoning | Use it for | Role prompt (gist) |
| --- | --- | --- | --- |
| `explore` | medium | Broad scouting / discovery over a codebase or corpus | Explore broadly but stay evidence-based; prefer read-only inspection, cite files/lines, call out uncertainty. |
| `researcher` | high | Independent evidence gathering, comparing alternatives | Gather independent evidence, compare alternatives, cite sources or files, separate facts from assumptions. |
| `planner` | high | Decomposition, dependency/risk mapping, routing | Decompose the task, identify dependencies and risks, propose a minimal verifiable plan with clear trade-offs. |
| `architect` | high | Solution **design** (distinct from planning) | Shape the solution design: define components, interfaces, boundaries, and data flow; weigh trade-offs and constraints; justify against requirements. |
| `implementer` | medium | Designing a concrete patch/diff | Prefer minimal changes, preserve existing behavior, explain verification steps; do not edit unless the caller explicitly allows it. |
| `reviewer` | high | Skeptical review / QA / gating risky output | Look for correctness, security, concurrency, and maintainability risks; cite concrete evidence; do not edit files. |

## `planner` vs `architect`

They are complementary, not redundant — the split mirrors the recurring
multi-agent role taxonomy (e.g. MetaGPT's Planner/PM vs. Architect):

- **`planner`** owns *decomposition and routing*: what steps, in what order, with
  what dependencies and risks.
- **`architect`** owns *solution shape*: components, interfaces, boundaries, data
  flow, and the trade-offs behind them.

Use `planner` to decide **what to do**; use `architect` to decide **how the
solution is structured**.

## Notes

- Reasoning defaults map onto the engine's effort scale; pass `effort`/`thinking`
  explicitly to override.
- Personas set only the persona-safe option keys (`tools`, `excludeTools`,
  `skills`, `includeSkills`, `extensions`, `model`, `provider`, `thinking`,
  `includeExtensions`, `approve`, `useContextFiles`, `systemPrompt`,
  `appendSystemPrompt`, `timeoutMs`, `keys`, `env`, `inheritEnv`).
- There is intentionally **no `executor`** built-in: a tool/code runner would
  break the read-only-by-default invariant. Grant write/exec tools explicitly on
  a specific call instead, as a conscious decision.
