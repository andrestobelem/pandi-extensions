# pi-worktree

Manage [git worktrees](https://git-scm.com/docs/git-worktree) from inside a Pi
session. Two surfaces:

- **`/worktree`** — human slash command (interactive, with confirmations and
  subcommand completions).
- **`git_worktree`** — a model-callable tool so Pi can list/add/open/remove/prune
  worktrees on its own instead of hand-writing `git worktree` bash commands.

Both share the same pure helpers, and `git` is always spawned with an **argv
array (never a shell string)**, so paths and branch names cannot inject shell
commands.

## Command

```text
/worktree                                  list worktrees (interactive menu in a TUI)
/worktree list                             list worktrees
/worktree add [-b <branch>] [--detach] [--force] [--copy-ignored] [--copy-untracked] <path> [<commit-ish>]   add a worktree
/worktree open [-b <branch>] [--detach] [--force] [--copy-ignored] [--copy-untracked] <path> [<commit-ish>]  create-if-missing, then open Pi in it
/worktree remove [--force] <path>          remove a worktree (confirms first)
/worktree prune [--dry-run]                prune stale worktree metadata (previews first)
```

- `add -b <branch> <path>` creates a new branch and checks it out in the new
  worktree.
- `open <path>` creates the worktree if it does not exist yet (same flags as
  `add`) and then starts a **new Pi session** in it. Under Supacode it opens a
  new tab (`supacode tab new -i "cd <path> && exec pi"`); otherwise it reports
  the `cd <path> && pi` command. The current session's `cwd` is never moved.
- On `add`/`open`, pass `--copy-ignored` (tool: `copyIgnored: true`) to copy
  gitignored files (e.g. `node_modules`) from the main worktree into the new
  one, and/or `--copy-untracked` (tool: `copyUntracked: true`) to copy untracked
  files. Both are **off by default** and run only when the worktree is newly
  created; the worktrees base dir and `.git` are never copied, so a new worktree
  is never recursively filled with other worktrees.
- A **bare `<name>`** (no path separator) is created under the default base
  `.pi/worktrees/<name>`, which is kept local and gitignored automatically (a
  `.pi/worktrees/.gitignore` containing `*` is written on first use). Use an
  explicit path — `./x`, `../x`, `/abs/x`, or `~/x` — to place it elsewhere.
- `remove` asks for confirmation; if the worktree is dirty or locked, git
  refuses and you get a second, explicit "force removal" confirmation.
- `prune` always shows a `--dry-run` preview before deleting anything.

## Tool

The `git_worktree` tool takes an `action` (`list` | `add` | `open` | `remove` |
`prune`) plus `path`, `branch`, `commitish`, `detach`, `force`, `dryRun`,
`copyIgnored`, and `copyUntracked`. It returns a text summary and structured
`details` (the parsed worktree list, the created path, the opened tab id, etc.). It **never force-deletes by default**:
`remove` only discards a dirty worktree when `force: true` is passed explicitly.

## Default location

Giving `add` a bare name (no `/`) drops the worktree in `.pi/worktrees/<name>`
relative to the repo, so all session-local worktrees live in one gitignored
place:

```text
/worktree add -b feat feat     →  <repo>/.pi/worktrees/feat   (gitignored)
/worktree add ../feat          →  <repo>/../feat              (explicit, literal)
```

## Note on `cwd`

Pi's working directory is fixed for the session and cannot change mid-session.
This extension therefore never "switches" the **current** session into another
worktree. Instead, `open` starts a **separate** Pi session in the worktree (a new
Supacode tab when available), and `list`/`add`/`remove` report each worktree's
**absolute path** so you can open a new Pi yourself:

```sh
cd <worktree-path> && pi
```

This keeps long-running work in the current session (for example a `/loop` or
`/goal`) untouched while you fan out into one worktree per parallel track.

## Install

```sh
pi install ./extensions/pi-worktree
# or, to try without installing:
pi --no-extensions -e ./extensions/pi-worktree
```
