# @pandi-coding-agent/pandi

Pandi 🐼 — a panda mascot for Pi, in the spirit of Claude Code's character/indicator, but as a panda.

## What you get

- Startup splash header: a block-art panda face with name and tagline beside it. The palette adapts to your theme (light/dark) so the face stays visible on any terminal background.
- Animated working indicator while Pi thinks, with 5 face styles cycled via `/pandi face`: `claude` `(●  ●)` (with `◆` eyes), `kaomoji` `ʕ•ᴥ•ʔ`, `ojitos` `ʕ◕ᴥ◕ʔ`, `decidido` `ʕ•̀ᴥ•́ʔ`, and `gatuno` `(=◕ᴥ◕=)`. Eyes use semantic theme colors (`ojitos`→`success`, the rest→`accent`).
- A playful verb that rotates each turn, plus an occasional meme-quote easter egg.
- A `◆ Pandi` status entry in the footer.
- A persona in the system prompt: while Pandi is on, a `<pandi_persona>` block (gentle/zen tone plus an occasional 🐼 signature) is appended to the system prompt. `/pandi off` removes it and restores the default persona.

## Install

From npm:

```bash
pi install npm:@pandi-coding-agent/pandi
```

From this repository:

```bash
pi install ./extensions/pi-pandi          # global (your user)
pi install -l ./extensions/pi-pandi       # project-local
pi --no-extensions -e ./extensions/pi-pandi   # one-off trial, nothing else loaded
```

## Commands

| Command | What it does |
| --- | --- |
| `/pandi` | Show status and a greeting (with no args in an interactive UI, opens a small menu). |
| `/pandi art` | Show or hide the panda splash header. |
| `/pandi face` | Cycle to the next of the 5 indicator face styles (persisted across sessions). |
| `/pandi off` | Turn Pandi off and restore the default header, spinner, and persona. |
| `/pandi on` | Turn Pandi back on. |

## Details

The face style chosen with `/pandi face` is saved to `pandi-style.local.json` next to the extension (git-ignored).

## Related

For the full bundle of extensions and skills, install the repository root instead.
