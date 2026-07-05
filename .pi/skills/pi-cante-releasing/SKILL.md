---
name: pi-cante-releasing
description: Release and maintain the pi-cante / pandi distributions (the pi coding agent fork at ~/ws/at/pi-cante that bundles the @pandi-coding-agent/* extension pack). Use when publishing a new distro version, bumping the bundled extension pins after publishing extensions from this repo, syncing the fork onto a new upstream pi release tag, or adding a new distribution. Covers the dry-run-first scripts, version scheme, and hard-won npm/fork gotchas.
---

# Releasing the pi-cante / pandi distributions

## The setup (mental model first)

- **Fork**: `andrestobelem/pi-cante`, local clone at `/Users/andrestobelem/ws/at/pi-cante`, fork of `earendil-works/pi` (the pi monorepo; the CLI is the `packages/coding-agent` workspace).
- **`main` is always `<upstream release TAG> + N distro commits`** — never upstream's main tip. The dist must be compiled against the *published* `@earendil-works/pi-*` versions; building from tip breaks at install time (learned the hard way).
- **Multi-distro**: `distros.json` declares the distributions sharing the one workspace. Currently:

  | key | npm | bin | configDir |
  |---|---|---|---|
  | `pi-cante` (committed default) | `@pandi-coding-agent/pi-cante` | `pi-cante` | `.pi-cante` |
  | `pandi` | `pandi-coding-agent` (unscoped — `@pandi-coding-agent/pandi` is taken by the pandi *extension*) | `pandi` | `.pandi` |

- **Versions**: `<upstream base>-<distro>.<n>` (e.g. `0.80.3-cante.1`). npm prereleases MUST be published with `--tag latest` explicitly; `npm i -g` follows the dist-tag so semver ordering doesn't matter.
- The 21 `@pandi-coding-agent/*` extensions are **pinned `dependencies`** locked by the published `npm-shrinkwrap.json` — NOT `bundledDependencies` (npm assumes those are in the tarball and silently skips installing them; workspace hoisting keeps them out of the tarball).

## The three flows (all scripts are dry-run by default)

Run everything from the fork root. Full doc: `RELEASING.md` in the fork.

### 1. Release the distros

```bash
node scripts/release-distros.mjs                 # dry run
node scripts/release-distros.mjs --publish       # real
node scripts/release-distros.mjs --only pandi --publish
```

Per distro: `set-distro` → build → branding test subset → publish. Skips versions already on npm; always restores the committed default and checks the tree is clean. Needs a clean `packages/coding-agent` tree + npm publish rights.

### 2. Bump the bundled extension pins

After publishing new `@pandi-coding-agent/*` versions from pandi-extensions (`node scripts/publish-npm.mjs --publish` there):

```bash
node scripts/bump-extensions.mjs           # dry run: report outdated pins
node scripts/bump-extensions.mjs --write   # update pins, bump -<distro>.N, npm install, regen locks
```

Then review the diff, commit with `PI_ALLOW_LOCKFILE_CHANGE=1 git commit ...`, and run flow 1.

### 3. Sync onto a new upstream release

```bash
node scripts/sync-upstream.mjs           # dry run: current base + newest upstream tag
node scripts/sync-upstream.mjs v0.81.0   # rebase distro commits onto the tag + verify
```

Conflicts land in `packages/coding-agent/package.json` and lockfiles: take the upstream side, then `set-distro` regenerates. After green: `git push --force-with-lease origin main`, then flow 1.

### Typical release day

```text
pandi-extensions: publish-npm.mjs --publish
→ fork: bump-extensions --write → commit → release-distros --publish → push
```

## Adding a new distribution

1. Add an entry to `distros.json` (name/bin/piConfig/versionSuffix/description). Check the npm name is free FIRST (`npm view <name> version` → expect E404).
2. Add the npm name to `internalPackageNames` in BOTH `scripts/generate-coding-agent-shrinkwrap.mjs` and `scripts/generate-coding-agent-install-lock.mjs`.
3. `node scripts/set-distro.mjs <key>` → build → smoke (`dist/cli.js --version`, config shows the right APP/configDir/agentDir) → restore. Then release via flow 1.

## Gotchas (each one cost real debugging)

- `~/.npmrc` has `min-release-age=7`: fresh packages 404 without `--min-release-age=0` (scripts pass it). npm may also quarantine burst publishes from the org (~1h propagation).
- Builds regenerate `packages/ai/src/providers/*.models.ts` as a side effect — discard with `git checkout -- packages/ai`, never commit them.
- The fork's pre-commit hook blocks lockfile changes without `PI_ALLOW_LOCKFILE_CHANGE=1`.
- `install-lock/` is repo-internal (not in the published tarball); only the shrinkwrap ships, so `set-distro` regenerates only the shrinkwrap.
- Extensions are host-aware since local-memory/auto-compact/goal/loop/worktree@0.2.0 and dynamic-workflows/rename@0.3.0: paths via `CONFIG_DIR_NAME`, subagent spawns via the host's `piConfig.name` (read through `getPackageDir()` — `APP_NAME` is not exported by the SDK).
- Verify a release end-to-end in an ephemeral container: `npm i -g <pkg>` in `node:24-slim`, check `--version`, `configDir`, and that `~/.pi` is untouched.
