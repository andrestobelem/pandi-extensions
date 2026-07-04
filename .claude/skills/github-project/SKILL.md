---
name: github-project
description: >-
  Manage this repo's issue tracking on the GitHub Project v2
  "pi-dynamic-workflows" (user andrestobelem, project #4) with the gh CLI.
  Use when creating stories/tasks/bugs, adding items to the board, moving
  Status (Todo / In Progress / Done), closing work from commits, or answering
  "what is on the board / in progress / left to do".
---

# github-project

All work on this repo is tracked as **repo issues** placed on the **GitHub
Project v2 board "pi-dynamic-workflows"** (owner: user `andrestobelem`,
project `4`), driven entirely from the terminal with `gh`. This skill carries
the verified IDs and the exact command recipes so no session has to
re-discover them.

## Conventions (the contract)

- **Issues are the unit of work**, labelled by kind: `story` (user-facing
  story / epic), `task` (concrete task), `bug`, `tests` (test-suite work),
  `tech-debt` (debt / process improvement). Combine kind labels when honest
  (e.g. `task,tests`).
- **Board Status** groups items: `Todo` → `In Progress` → `Done`. Move an item
  to In Progress when you actually start it.
- **Close from the commit that finishes the work**: put `Closes #N` in the
  commit message body. When the commit lands on the default branch, GitHub
  closes the issue and the built-in project workflow moves its card to Done —
  no manual board edit needed.
- **Stories link their sub-tasks**: the parent story lists them in its body;
  each sub-task's body says `Part of #N`. Keep sub-tasks small and
  independently closeable.

## Verified constants (2026-07-04)

| What | Value |
| --- | --- |
| Repo | `andrestobelem/pi-dynamic-workflows` |
| Project | number `4`, owner `andrestobelem` (user project, private) |
| Project ID | `PVT_kwHOAEKsO84BcY5A` |
| Status field ID | `PVTSSF_lAHOAEKsO84BcY5AzhXCGf4` |
| Status option: Todo | `f75ad846` |
| Status option: In Progress | `47fc9ee4` |
| Status option: Done | `98236657` |

If an `item-edit` fails with an unknown field/option, re-derive the IDs (they
only change if the field is recreated):

```bash
gh project field-list 4 --owner andrestobelem --format json \
  --jq '.fields[] | select(.name == "Status") | {id, options: [.options[] | {name, id}]}'
```

## Recipes

Preflight once per session if anything fails with auth errors: `gh auth status`
(the token must carry the `project` scope; `gh auth refresh -s project` fixes it).

### Create an issue and put it on the board

```bash
gh issue create --title "P5: cover pi-effort parse errors" \
  --body "Part of #1. <what + why + evidence expected>" \
  --label task,tests
gh project item-add 4 --owner andrestobelem --url <issue-url-from-previous-output>
```

A freshly added item may have NO Status yet — set `Todo` explicitly with the
move recipe below so it shows up in the right column.

### Find a board item id from an issue number

`item-edit` needs the PVTI item id, not the issue number:

```bash
gh project item-list 4 --owner andrestobelem --limit 200 --format json \
  --jq '.items[] | select(.content.number == 2) | .id'
```

(Default `--limit` is 30 — always pass a generous one; the board already has ~26 items.)

### Move an item's Status

```bash
gh project item-edit --id <PVTI-item-id> \
  --project-id PVT_kwHOAEKsO84BcY5A \
  --field-id PVTSSF_lAHOAEKsO84BcY5AzhXCGf4 \
  --single-select-option-id 47fc9ee4   # Todo f75ad846 · In Progress 47fc9ee4 · Done 98236657
```

### Finish work

Prefer closing from the landing commit (`Closes #N` in the body) over manual
closes. Manual fallback: `gh issue close <N> --comment "<evidence>"` — the
project workflow still moves the card to Done.

### Query the board

```bash
# Everything, grouped fields flattened: id | status | issue | labels | title
gh project item-list 4 --owner andrestobelem --limit 200 --format json \
  --jq '.items[] | [.id, .status, "#\(.content.number)", (.labels | join(",")), .title] | @tsv'

# Only what is in progress (or Todo / Done)
gh project item-list 4 --owner andrestobelem --limit 200 --format json \
  --jq '.items[] | select(.status == "In Progress") | "#\(.content.number) \(.title)"'
```

Issue-side queries stay on the repo: `gh issue list --label task --state open`.

## Gotchas

- `gh project` subcommands need `--owner andrestobelem` every time — without it
  gh guesses from the repo and user projects are not found.
- `item-list` JSON: `status` is a plain string (`"Todo"` / `"In Progress"` /
  `"Done"`), the issue number is `content.number`, labels is a string array.
- The project is **private**: link cards by issue number in text, don't expect
  external viewers to resolve project URLs.
- One `item-edit` sets ONE field; Status moves and other field edits are
  separate calls.
