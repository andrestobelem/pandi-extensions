# pi-dynamic-workflows-pandi

Pandi 🐼 — un personaje panda para Pi, en el espíritu del personaje/indicador de
Claude Code, pero como oso panda.

## Install

From this repository:

```bash
pi install ./extensions/pi-pandi
pi install -l ./extensions/pi-pandi
pi --no-extensions -e ./extensions/pi-pandi
```

## Provides

- Splash en el header de arranque: cara de panda en block-art con el nombre y la
  frase al lado, estilo la pantalla de presentación de Claude Code. La paleta se
  adapta al tema (claro/oscuro) para que la cara clara y los parches oscuros sigan
  visibles en cualquier fondo de terminal.
- Indicador animado mientras Pi piensa, con dos estilos de carita:
  kaomoji `ʕ•ᴥ•ʔ` ↔ Claude `(●  ●)` (con ojos `◆`). El estilo kaomoji va
  **rotando de expresión** (básico, ojitos, decidido, gatuno, feliz…), no solo
  parpadea.
- Verbo juguetón rotativo por turno + un easter egg con la frase del meme.
- Estado `◆ Pandi` en el footer.

## Commands

- `/pandi` — estado + saludo.
- `/pandi art` — mostrar/ocultar el splash del panda.
- `/pandi face` — alternar la carita del indicador (se guarda entre sesiones).
- `/pandi off` — apagar Pandi y restaurar el header y el spinner por defecto.
- `/pandi on` — volver a encender Pandi.

El estilo de carita elegido con `/pandi face` se guarda en
`pandi-style.local.json` (junto a la extensión, ignorado por git).
