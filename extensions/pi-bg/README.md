# @pandi-coding-agent/bg

Individual Pi package for the `/bg` local background jobs extension.

`/bg` is the small, human-only sibling of `dynamic_workflow` background runs: it
is in-memory and **not** resumable/journaled. Use `dynamic_workflow` for
resumable agentic orchestration and `/bg` for one-off human background commands.

## Install

From this repository:

```bash
pi install ./extensions/pi-bg
pi install -l ./extensions/pi-bg
pi --no-extensions -e ./extensions/pi-bg
```

## Provides

- `/bg preview <command>` — preview a background job (deprecated alias: `/bg plan`).
- `/bg start <command>` — start a trusted project-local background job.
- `/bg list` — list known jobs.
- `/bg status <jobId>` — inspect a job.
- `/bg logs <jobId>` — read bounded logs.
- `/bg events <jobId>` — read the bounded lifecycle journal (`events.jsonl`).
- `/bg cancel <jobId>` — cancel an active job from the current Pi process.
- `/bg delete <jobId>` — delete one finished (terminal) job's artifacts.
- `/bg prune [--yes]` — preview deletable jobs (dry-run by default); `--yes` removes them.

Artifacts are written under `.pi/bg/runs/` for trusted projects. For the full bundle of extensions and skills, install the repository root instead.

## Behavior and artifacts (M2)

- `/bg start` only works in persistent TUI/RPC sessions and trusted projects; in
  untrusted projects it is refused before executing or writing artifacts. The
  trust/mode gate protects the project's **context and artifacts**, not the
  command itself: like the rest of Pi's exec, `/bg start` runs whatever the human
  types via `shell:true`.
- `/bg start` and `/bg cancel` are blocked while `/plan` is active.
- No `background_job` LLM tool is registered; the mutating surface is
  human-only slash commands.
- `/bg events <jobId>` shows the bounded tail of the `events.jsonl` journal
  (start/running/cancel-*/finish/reconcile-interrupted/finalize-error): the
  evidence for *why* a job ended `failed`/`cancelled`/`interrupted`, which
  `status.json` alone does not carry.
- Project-local artifacts live in `.pi/bg/runs/<jobId>/`; the global read
  fallback uses `~/.pi/agent/bg/runs/<cwd-hash>/<jobId>/` (in M2 that global root
  is **read-only**). Each run contains `job.json`, `status.json`, `events.jsonl`,
  `stdout.log`, `stderr.log`, `combined.log`.
- `job.json` and `status.json` are written with temp file + atomic rename; logs
  are append-only and `/bg logs` reads them bounded/truncated.
- There is no Supacode runner, daemon, automatic rehydration, or `/bg`
  dashboard in M2.

## Limitations

- Jobs are tracked in memory by the Pi process that started them. They do not
  survive a restart: after Pi exits or crashes, a previously `running` job
  cannot be cancelled with `/bg cancel` (it refuses any job not active in the
  current session).
- For such not-owned jobs, `/bg status`/`/bg list` project the state at read time
  by probing the recorded pid (signal-0, no signal sent): `orphaned` (pid still
  alive — a detached process likely still running), `interrupted` (pid dead — Pi
  died before finalizing), or `stale` (no pid to probe).
- To defeat pid reuse, each job also records a process **start identity**
  (`startId`: Linux `/proc` starttime; macOS/BSD `ps -o lstart=`; absent on
  Windows). `/bg status` does one identity probe: a live pid whose identity still
  matches is a verified `orphaned` (`identity: verified`); a live pid whose
  identity differs means the pid was reused, so it is reported as `interrupted`
  (`interruptedCause: pid-reused`); when identity can't be read it stays a
  best-effort `orphaned` with a verify-before-kill hint. `/bg list` keeps only the
  cheap signal-0 probe (no per-job subprocess), so it can show a best-effort
  `orphaned` that `/bg status` would refine.
- On session start (persistent, trusted sessions only) pi-bg self-heals: a
  project-local job persisted as `running`/`starting` is atomically rewritten to a
  terminal `interrupted` on disk when its pid is dead **or** alive-but-reused (a
  different start identity), so the artifact stops claiming `running` forever.
  Jobs whose pid is verified-alive or unprobeable are left untouched (still
  projected as `orphaned`/`stale`). Terminalizing only on positive evidence (dead
  pid or proven reuse) keeps the rewrite safe.
- Started jobs are detached process groups, so a still-running detached job is
  left orphaned after a restart. A **verified** orphan can be stopped with
  `/bg cancel` (see below); otherwise use OS tools (for example `kill`/`pkill`
  or `taskkill`).
- `/bg cancel` always acts on jobs owned by the current Pi process. For a job
  persisted by another session it signals the process group **only** when the
  recorded start identity proves the live pid is still that job's process (a
  verified orphan): it sends `SIGTERM` to the group and rewrites the job to
  `cancelled` (reason `cancel-verified-orphan`). A reused pid or one whose
  identity cannot be read is refused and never signaled — stop it with OS tools.
- The trust/mode gate protects the project's **context and artifacts**, not the
  command itself: like the rest of Pi's exec, `/bg start` runs whatever the human
  types via `shell:true`.
- `/bg delete <jobId>` and `/bg prune` reclaim disk safely: they remove only
  **finished** jobs (a job's live state is re-derived at prune time, so a running,
  session-active, or identity-verified-alive job is never deleted), act on the
  project-local store only (global-fallback jobs are read-only), are symlink/path
  safe (an inner symlink is unlinked, not followed), and append one
  `.pi/bg/runs/.audit.jsonl` line per removal. `/bg prune` is a dry-run preview
  unless given `--yes`.
- The command (`job.json`) and its output (`stdout/stderr/combined.log`) are
  stored in **plaintext** and are not redacted. Avoid passing secrets on the
  command line; reclaim space with `/bg prune` (bulk) or `/bg delete <jobId>`
  (one) — both remove finished jobs only and record an audit line.
