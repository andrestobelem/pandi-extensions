---
name: sync-doc-mirrors
description: >-
  Check and regenerate a repo's committed md ↔ html doc mirrors with the
  pandi-docs mirror engine (sync-doc-mirrors.mjs --check / sync). Use after
  editing any mirrored markdown doc, when asked whether the doc mirrors are in
  sync, or to set up manifest-driven mirrors (mirrors.json) in a new repo.
  Invoked with /sync-doc-mirrors.
---

# sync-doc-mirrors

Keep a repo's markdown docs and their committed, styled HTML mirrors in sync.
The mechanism is `scripts/sync-doc-mirrors.mjs` in the `pandi-docs` extension:
each mirror pair is an entry `{source, out?, kicker?, tokens?, css?, artifact?}`,
declared in a committed `mirrors.json` plus an optional gitignored
`mirrors.local.json` sibling (per-developer docs). Rendering uses the pandi
converter; a repo with its own look points `css` (full stylesheet) or `tokens`
(palette only) at its own file.

## Locate the engine

- **In pandi-extensions itself:** don't call the engine directly for `docs/html/`
  — use the policy wrapper: `npm run sync:docs:html` / `npm run sync:docs:html:check`.
- **In a consuming repo:** the engine ships with the installed package
  (`node_modules/@pandi-coding-agent/pandi-docs/scripts/sync-doc-mirrors.mjs`)
  or a checkout of this repo (`extensions/pandi-docs/scripts/sync-doc-mirrors.mjs`).
  Prefer wiring it as an npm script (`docs:sync` / `docs:check`) so CI and
  pre-commit call the same entry point.

## Steps

1. From the repo root, check for drift:

   ```bash
   node <engine>/sync-doc-mirrors.mjs --config path/to/mirrors.json --check
   ```

   - Exit 0 (`mirrors en sync`) → report that and stop.
   - Exit 1 → it lists each stale mirror (or a bad-href source error); continue.
2. If it reported `.html` links whose `.md` twin is in the set, fix the source
   markdown first — in-set docs link to `.md`; the mirror owns the `.md → .html`
   rewrite.
3. Regenerate (writes only the mirrors whose content actually changed):

   ```bash
   node <engine>/sync-doc-mirrors.mjs --config path/to/mirrors.json
   ```

4. Commit each `.md` and its regenerated `.html` **in the same commit** as the
   edit that caused the drift. `mirrors.local.json` pairs are gitignored —
   nothing to commit for those.
5. `↳ redeploy artifact <url>` lines appear only under mirrors that really
   changed and have an `artifact` entry. For each one, redeploy the regenerated
   HTML to that same url (keeping the manifest's `favicon`) so all three layers
   (md → html → artifact) stay aligned.

## New pair / new repo

- Add an entry to `mirrors.json`: `source` (repo-relative `.md`) is enough;
  `out` defaults to the sibling `.html`. Add `kicker` for the header label,
  `artifact {url, favicon}` if the page is published as a Claude artifact,
  and `tokens` or `css` if the doc needs a non-pandi look.
- Gate it: add the `--check` invocation to the repo's test script, CI, or
  pre-commit hook so drift fails fast.

## Notes

- `skip:` lines mean the source md is missing on this branch — fine, not an error.
- Never hand-edit a generated `.html`; fix the markdown and re-sync.
- One-off conversions (no manifest) use `/docs <file.md>` or the
  `markdown_to_html` tool instead.
