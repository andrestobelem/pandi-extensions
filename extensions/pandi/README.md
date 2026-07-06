# @pandi-coding-agent/pandi

Pandi 🐼 is a panda mascot for Pi: a themed splash header, an animated "thinking" indicator, and a gentle persona — in the spirit of Claude Code's character, but as a panda. Reach for it when you want your terminal session to feel more alive without changing how Pi actually works.

```text
/pandi face
```

That cycles the working indicator to the next of 5 panda faces (persisted across sessions) and shows a live sample, e.g. `ʕ ◕ᴥ◕ ʔ Estilo ojitos (guardado).`

## What you get

- Startup splash header: a block-art panda face with name and tagline beside it. The palette adapts to your theme (light/dark) so the face stays visible on any terminal background.
- Animated working indicator while Pi thinks, with 5 face styles cycled via `/pandi face`: `claude` alternates `(●  ●)` with `ʕ •ᴥ• ʔ` (plus `◆` glints), `kaomoji` `ʕ •ᴥ• ʔ`, `ojitos` `ʕ ◕ᴥ◕ ʔ`, `decidido` `ʕ •̀ᴥ•́ ʔ`, and `gatuno` `(=◕ᴥ◕=)`. Eyes use semantic theme colors (`ojitos`→`success`, the rest→`accent`).
- A playful verb that rotates each turn, plus an occasional meme-quote easter egg.
- A `◆ Pandi` status entry in the footer.
- A persona in the system prompt: while Pandi is on, a `<pandi_persona>` block (gentle/zen tone; creative, didactic and concise character; an occasional 🐼 signature) is appended to the system prompt. `/pandi off` removes it and restores the default persona.

## Install

From npm:

```bash
pi install npm:@pandi-coding-agent/pandi
```

From this repository:

```bash
pi install ./extensions/pandi          # global (your user)
pi install -l ./extensions/pandi       # project-local
pi --no-extensions -e ./extensions/pandi   # one-off trial, nothing else loaded
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
