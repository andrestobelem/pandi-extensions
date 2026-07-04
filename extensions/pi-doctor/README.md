# @pandi-coding-agent/doctor

Adds `/doctor`, an in-session shortcut for the pi-dynamic-workflows environment
check. It answers "is my machine set up right?" without leaving the chat —
the same read-only report as `npm run doctor`, one keystroke away.

## Quickstart

```text
/doctor
```

```text
pi-dynamic-workflows doctor

Obligatorios:
  ✓ Node.js 22.19.0 — ≥ 22.19.0
...

✓ Todos los requisitos obligatorios están presentes.
```

The command finds `scripts/doctor.mjs`, runs it, and shows the report as an
`info` (all mandatory checks pass), `error` (non-zero exit or timeout), or
`warning` (script not found) message.

## Install

| Mode | Command | When to use it |
| --- | --- | --- |
| From npm | `pi install npm:@pandi-coding-agent/doctor` | Standalone use, outside this repo |
| Global | `pi install ./extensions/pi-doctor` | You want `/doctor` in every session |
| Project-local | `pi install -l ./extensions/pi-doctor` | Only this project should get `/doctor` |
| One-off trial | `pi --no-extensions -e ./extensions/pi-doctor` | Try it with nothing else loaded |

## Commands

| Command | What it does |
| --- | --- |
| `/doctor` | Run the environment check (`scripts/doctor.mjs`) and show the report. |

## How it works

- Walks up from the session cwd looking for a working-tree copy
  (`<repo>/extensions/pi-doctor/scripts/doctor.mjs`), so in-repo dev always
  runs the freshest version; falls back to the vendored copy shipped in the
  npm tarball for standalone installs.
- Spawns it with `node` using an argv array — never a shell string — and
  captures the output with `NO_COLOR` set, so the report is plain text.
- Runs the script as a subprocess found at runtime instead of importing it: a
  static import would break bundling, so the extension itself always loads.

## Limitations & safety notes

- Standalone installs degrade honestly: `sync Claude global` reports `N/A`
  outside the suite repo, local `node_modules` probes use the session cwd,
  and the double-copy check skips working-tree detection.
- During onboarding, before `pi install ./` + `/reload`, use `npm run doctor`
  instead — `/doctor` only exists once the extension is loaded.
- The check times out after 120 seconds and reports the timeout as an error.

## Related

For the full bundle of extensions and skills, install the repository root
instead.
