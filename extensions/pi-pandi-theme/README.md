# @pandi-coding-agent/pandi-theme

Panda Syntax themes for Pi 🐼, the visual companion to the Pandi mascot
(`pi-pandi`): a TUI port of the classic editor theme
[Panda Syntax](https://github.com/PandaTheme), in dark and light variants.
Reach for it when you want Pi's terminal UI to match that palette instead of
the default theme.

## Quickstart

Install it, then pick the theme:

```bash
pi install npm:@pandi-coding-agent/pandi-theme
```

```json
{ "theme": "panda-syntax-light/panda-syntax-dark" }
```

That's it — no commands, no tools, no config beyond `settings.json`. This
package is themes only: it declares `pi.themes` in `package.json` and ships
no code extension.

## What you get

- `panda-syntax-dark` — `#292A2B` background with `#19F9D8` (panda green),
  `#FF75B5` (pink), and `#45A9F9` (blue) accents.
- `panda-syntax-light` — the same palette adapted to light terminals.

## Install

| Source | Command |
| --- | --- |
| npm | `pi install npm:@pandi-coding-agent/pandi-theme` |
| repo, global (your user) | `pi install ./extensions/pi-pandi-theme` |
| repo, project-local | `pi install -l ./extensions/pi-pandi-theme` |
| repo, one-off trial | `pi --no-extensions -e ./extensions/pi-pandi-theme` |

The one-off trial loads nothing else, useful for previewing the theme
without touching your installed extensions.

## Usage

Pick the theme via `/settings`, or set it directly in `settings.json`:

```json
{
  "theme": "panda-syntax-light/panda-syntax-dark"
}
```

The `light/dark` form lets Pi choose the variant from your terminal's
detected background. To pin a single variant instead, use
`"theme": "panda-syntax-dark"` (or `panda-syntax-light`).

## Details

- The two theme JSON files live in `themes/` and each declare all 51 color
  tokens required by Pi's theme schema.
- If you edit the active theme file on disk, Pi hot-reloads it.

## Related

For the full bundle of extensions and skills, install the repository root
instead.
