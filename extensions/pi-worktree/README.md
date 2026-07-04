# @pandi-coding-agent/worktree

Manage [git worktrees](https://git-scm.com/docs/git-worktree) from inside a Pi session — list, add, open, remove, and prune, with an interactive `/worktree` command and a model-callable `git_worktree` tool.

## What you get

- `/worktree` slash command with confirmations, subcommand completions, and an interactive list menu in a TUI.
- `git_worktree` model tool so Pi manages worktrees itself instead of hand-writing `git worktree` bash commands.
- Optional copying of gitignored (e.g. `node_modules`) and untracked files into a newly created worktree.
- A gitignored default home for bare-named worktrees: `.pi/worktrees/<name>`.

## Install

From npm:

```bash
pi install npm:@pandi-coding-agent/worktree
```

From this repository:

```bash
pi install ./extensions/pi-worktree          # global (your user)
pi install -l ./extensions/pi-worktree       # project-local
pi --no-extensions -e ./extensions/pi-worktree   # one-off trial, nothing else loaded
```

## Commands

| Command | What it does |
| --- | --- |
| `/worktree` | List worktrees (interactive menu in a TUI). |
| `/worktree list` | List worktrees with their absolute paths. |
| `/worktree add [-b <branch>] [--detach] [--force] [--copy-ignored] [--copy-untracked] <path> [<commit-ish>]` | Add a worktree; `-b` creates and checks out a new branch. |
| `/worktree open [same flags as add] <path> [<commit-ish>]` | Create the worktree if missing, then open a new Pi session in it. |
| `/worktree remove [--force] <path>` | Remove a worktree (confirms first). |
| `/worktree prune [--dry-run]` | Prune stale worktree metadata (previews first). |
| `/worktree set [copy-ignored\|copy-untracked] [on\|off\|status]` | Set or show the session copy defaults. |
| `git_worktree` | Model tool: takes `action` (`list`/`add`/`open`/`remove`/`prune`) plus `path`, `branch`, `commitish`, `detach`, `force`, `dryRun`, `copyIgnored`, `copyUntracked`; returns a text summary and structured `details`. |

## How it works

- **`open` never moves your session.** Pi's `cwd` is fixed for the session, so `open` starts a *separate* Pi session in the worktree. Under Supacode it opens a new tab (`supacode tab new -i "cd <path> && exec pi"`); otherwise it reports the `cd <path> && pi` command for you to run. Long-running work in the current session (a `/loop`, a `/goal`) stays untouched.
- **Bare names get a default home.** A `<name>` with no path separator lands in `<repo>/.pi/worktrees/<name>`, gitignored automatically (a `.pi/worktrees/.gitignore` containing `*` is written on first use). Use an explicit path (`./x`, `../x`, `/abs/x`, `~/x`) to place it elsewhere.
- **Copy options** (`--copy-ignored`, `--copy-untracked`; tool: `copyIgnored`, `copyUntracked`) copy gitignored and/or untracked files from the main worktree into a *newly created* one. The worktrees base dir and `.git` are never copied, so a worktree never recursively fills with other worktrees.
- **Copy resolution precedence:** explicit per-call flag → session default → environment → off.
  - Per call: `--copy-ignored`/`--copy-untracked` force ON; `--no-copy-ignored`/`--no-copy-untracked` force OFF. The tool params are tri-state (`true`, `false`, or omitted to fall through).
  - Session default: `/worktree set copy-ignored on|off` and `/worktree set copy-untracked on|off`; `/worktree set` (or `… status`) reports the current resolution. Defaults reset at each session boundary.
  - Environment: `PI_WORKTREE_COPY_IGNORED` / `PI_WORKTREE_COPY_UNTRACKED` (truthy tokens: `1`/`true`/`on`/`yes`).

## Limitations & safety notes

- `git` is always spawned with an argv array — never a shell string — so paths and branch names cannot inject shell commands.
- `remove` confirms first; if the worktree is dirty or locked, git refuses and you get a second, explicit "force removal" confirmation. The tool never force-deletes by default: it discards a dirty worktree only with an explicit `force: true`.
- `prune` always shows a `--dry-run` preview before deleting anything.
- This extension never switches the **current** session's working directory into another worktree; it opens new sessions instead.

## Related

For the full bundle of extensions and skills, install the repository root instead.
