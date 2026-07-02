# @pandi-coding-agent/doctor

Adds a `/doctor` command that runs the pi-dynamic-workflows **environment check**
(the extension's vendored `scripts/doctor.mjs`) from inside a Pi session and shows
the report — the same read-only check as `npm run doctor`, one keystroke away.

## What it does

- Locates the check by walking up from the current working directory looking for a
  working-tree copy (`<repo>/extensions/pi-doctor/scripts/doctor.mjs`, so in-repo
  dev always runs the freshest version), falling back to this extension's **own
  vendored copy** — which ships in the npm tarball, so a standalone install works.
- Spawns it with `node` (an **argv array**, never a shell string) and captures the
  output. `doctor.mjs` discovers the suite root from the session cwd and emits
  plain text when piped (no ANSI), so the report shows cleanly.
- Surfaces the report via `notify` — `info` when all mandatory requirements are
  present, `error` when the check exits non-zero (a mandatory requirement is
  missing), and a friendly `warning` when run outside the repo.

## Usage

```text
/doctor
```

## Notes

- **Standalone-friendly:** installed à la carte (e.g. `npm:@pandi-coding-agent/doctor`),
  `/doctor` still runs — repo-only checks degrade honestly: `sync Claude global`
  reports `N/A` outside the suite repo, local `node_modules` probes use the session
  cwd, and the double-copy check skips working-tree detection.
- It does **not** import `scripts/doctor.mjs` (that would break bundling); it runs
  it as a subprocess found at runtime, so the extension itself always loads.
- During onboarding, before `pi install ./` + `/reload`, use `npm run doctor` — the
  `/doctor` command only exists once the extension is loaded.
