# pi-dynamic-workflows-bg

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

- `/bg plan <command>` — preview a background job.
- `/bg start <command>` — start a trusted project-local background job.
- `/bg list` — list known jobs.
- `/bg status <jobId>` — inspect a job.
- `/bg logs <jobId>` — read bounded logs.
- `/bg cancel <jobId>` — cancel an active job from the current Pi process.

Artifacts are written under `.pi/bg/runs/` for trusted projects. For the full bundle of extensions and skills, install the repository root instead.

## Limitations

- Jobs are tracked in memory by the Pi process that started them. They do not
  survive a restart: after Pi exits or crashes, a previously `running` job
  cannot be cancelled with `/bg cancel` (it refuses any job not active in the
  current session).
- For such not-owned jobs, `/bg status`/`/bg list` project the state at read time
  by probing the recorded pid (signal-0, no signal sent): `orphaned` (pid still
  alive — a detached process likely still running), `interrupted` (pid dead — Pi
  died before finalizing), or `stale` (no pid to probe). The probe is best-effort
  (a pid can be reused), so `orphaned` carries a verify-before-kill hint.
- On session start (persistent, trusted sessions only) pi-bg self-heals: a
  project-local job persisted as `running`/`starting` whose recorded pid is dead
  is atomically rewritten to a terminal `interrupted` on disk, so the artifact
  stops claiming `running` forever. Jobs with a live or unprobeable pid are left
  untouched (still projected as `orphaned`/`stale`). Writing `interrupted` only
  on a confirmed-dead pid keeps the rewrite safe against pid reuse.
- Started jobs are detached process groups, so a still-running detached job is
  left orphaned after a restart and must be stopped with OS tools (for example
  `kill`/`pkill` or `taskkill`).
- `/bg cancel` only acts on jobs owned by the current Pi process; it never
  signals a job persisted by another session or a previous run.
- The trust/mode gate protects the project's **context and artifacts**, not the
  command itself: like the rest of Pi's exec, `/bg start` runs whatever the human
  types via `shell:true`.
- The command (`job.json`) and its output (`stdout/stderr/combined.log`) are
  stored in **plaintext** and are not redacted or pruned. Avoid passing secrets
  on the command line; delete `.pi/bg/runs/<jobId>/` by hand to reclaim space.
