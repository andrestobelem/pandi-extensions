# Dynamic-workflow primitives (injected globals)

This folder is the **canonical, per-primitive reference** for the globals a
dynamic-workflow script can call — the analog of
`extensions/pi-dynamic-workflows/scaffolds/` for patterns.

The **source of truth** for *which* primitives exist is the runtime itself: the
`sandbox.<name> = …` assignments in
`extensions/pi-dynamic-workflows/worker-source.ts`. A parity test
(`extensions/pi-dynamic-workflows/tests/integration/primitives-parity.test.mjs`)
keeps this folder 1:1 with
that list — add or remove a global there and the test fails until the matching
`<name>.md` is added or removed here.

A workflow script calls these as **bare globals** — no `import`/`require`, no
`ctx.*`:

```js
export default async function main() {
  const findings = await agents(files, { concurrency: 8 });
  return compact(findings.filter(Boolean));
}
// (or a top-level script that ends in `return`)
```

**Runtime note:** the *source of truth* is the **pi `dynamic_workflow` runtime**.
The core (`agent`, `agents`, `parallel`, `pipeline`, `workflow`, `phase`, `log`,
`args`, `compact`) is shared with the Claude Code Workflow tool; the rest are
pi-runtime globals — don't assume they exist on Claude Code (keep cross-runtime
scaffolds to the shared core).

## Subagents & composition

- [`agent`](agent.md) — run one subagent; parsed object with `{ schema }`, else text; `null` on failure.
- [`agents`](agents.md) — bounded parallel map, one step per item (`{ concurrency, settle }`).
- [`parallel`](parallel.md) — barrier: run branches, wait for ALL results at once.
- [`pipeline`](pipeline.md) — dependent stages per item, no cross-item merge; failed items → `null`.
- [`race`](race.md) — first accepted value wins, cancel the in-flight losers.
- [`workflow`](workflow.md) — compose a reusable sub-workflow inline (depth-bounded).

## Human & observability

- [`ask`](ask.md) — human-in-the-loop question (input/confirm/select); resume-safe.
- [`phase`](phase.md) — mark the current phase for the dashboard/log.
- [`log`](log.md) — append a line to the run log.

## Filesystem & shell (confined to the run cwd)

- [`bash`](bash.md) — run a shell command; caching is opt-in (`{ cache: true }`).
- [`readFile`](readFile.md) — read a file relative to `cwd`.
- [`writeFile`](writeFile.md) — write a file (creates parent dirs).
- [`appendFile`](appendFile.md) — append to a file (creates parent dirs).
- [`listFiles`](listFiles.md) — recursively list files (skips `node_modules`/`.git`).

## Artifacts (persisted under `runDir`, inspectable)

- [`writeArtifact`](writeArtifact.md) — write a named run artifact.
- [`appendArtifact`](appendArtifact.md) — append to a named artifact (concurrency-safe).

## Utilities

- [`sleep`](sleep.md) — abortable delay.
- [`json`](json.md) — bounded, safe stringify.
- [`compact`](compact.md) — bounded stringify for prompts.
- [`args`](args.md) — the workflow input.

## Read-only run context

- [`limits`](limits.md) — `{ concurrency, maxAgents, … }` caps.
- [`runId`](runId.md) — this run's id.
- [`runDir`](runDir.md) — this run's directory (artifacts live here).
- [`cwd`](cwd.md) — the workflow's working directory.
