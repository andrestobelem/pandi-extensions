# @pandi-coding-agent/pandi-theme

Panda Syntax themes for Pi 🐼 — the visual companion to the Pandi mascot (`pi-pandi`). A Pi TUI port of the classic editor theme [Panda Syntax](https://github.com/PandaTheme), in dark and light variants.

## What you get

- `panda-syntax-dark` — `#292A2B` background with `#19F9D8` (panda green), `#FF75B5` (pink), and `#45A9F9` (blue) accents.
- `panda-syntax-light` — the same palette adapted to light terminals.
- Themes only: this package ships no code extensions (`pi.themes` in `package.json`).

## Install

From npm:

```bash
pi install npm:@pandi-coding-agent/pandi-theme
```

From this repository:

```bash
pi install ./extensions/pi-pandi-theme          # global (your user)
pi install -l ./extensions/pi-pandi-theme       # project-local
pi --no-extensions -e ./extensions/pi-pandi-theme   # one-off trial, nothing else loaded
```

## Usage

Pick the theme via `/settings`, or set it in `settings.json`:

```json
{
  "theme": "panda-syntax-light/panda-syntax-dark"
}
```

The `light/dark` form lets Pi choose the variant from your terminal's detected background. You can also pin a single variant (`"theme": "panda-syntax-dark"`).

## Details

- The two theme JSON files live in `themes/` and declare all 51 color tokens required by Pi's theme schema.
- If you edit the active theme on disk, Pi hot-reloads it.

## Related

For the full bundle of extensions and skills, install the repository root instead.
