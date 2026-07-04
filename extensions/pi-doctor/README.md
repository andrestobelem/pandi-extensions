# @pandi-coding-agent/doctor

Run the pi-dynamic-workflows environment check from inside a Pi session with `/doctor` — the same read-only report as `npm run doctor`, one keystroke away.

## What you get

- A `/doctor` command that finds `scripts/doctor.mjs` and shows its report in the session.
- In-repo dev always runs the freshest working-tree copy; standalone installs use the vendored copy shipped in the npm tarball.
- Clear severities: `info` when all mandatory requirements pass, `error` on a non-zero exit, `warning` with a friendly hint when the script cannot be found.

## Install

From npm:

```bash
pi install npm:@pandi-coding-agent/doctor
```

From this repository:

```bash
pi install ./extensions/pi-doctor          # global (your user)
pi install -l ./extensions/pi-doctor       # project-local
pi --no-extensions -e ./extensions/pi-doctor   # one-off trial, nothing else loaded
```

## Commands

| Command | What it does |
| --- | --- |
| `/doctor` | Run the environment check (`scripts/doctor.mjs`) and show the report. |

## How it works

- Locates the check by walking up from the session cwd for a working-tree copy (`<repo>/extensions/pi-doctor/scripts/doctor.mjs`), then falls back to the extension's own vendored copy.
- Spawns it with `node` using an argv array — never a shell string — and captures the output with `NO_COLOR` set, so the report is plain text.
- It runs the script as a subprocess found at runtime instead of importing it; a static import would break bundling, so the extension itself always loads.

## Limitations & safety notes

- Standalone installs degrade honestly: `sync Claude global` reports `N/A` outside the suite repo, local `node_modules` probes use the session cwd, and the double-copy check skips working-tree detection.
- During onboarding, before `pi install ./` + `/reload`, use `npm run doctor` — the `/doctor` command only exists once the extension is loaded.
- The check times out after 120 seconds and reports the timeout as an error.

## Related

For the full bundle of extensions and skills, install the repository root instead.
