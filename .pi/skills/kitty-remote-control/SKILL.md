---
name: kitty-remote-control
description: >-
  Controla la terminal kitty desde el shell mediante su protocolo de
  remote-control (`kitty @ ...`): abre tabs, ventanas y splits nuevos, y
  consulta/administra la instancia de kitty en ejecución. Activar cuando la
  persona usuaria pida abrir una tab o ventana nueva de kitty, dividir paneles
  (vertical/horizontal), o scriptear kitty desde una sesión en curso. Si la
  extensión pandi-kitty está instalada, preferí su comando `/kitty` o la tool
  `kitty_remote` antes que shell ad hoc.
---

# Control remoto de kitty

## En 30 segundos

`kitty @` controla la instancia kitty en ejecución (tabs, ventanas, splits).
Requiere `allow_remote_control yes` en `kitty.conf`. Si `pandi-kitty` está
instalada, preferí `/kitty` o `kitty_remote`.

```bash
kitty @ launch --type=tab
```

kitty trae un protocolo de remote-control manejado por el subcomando
`kitty @`. Habla con la instancia de kitty *actualmente en ejecución* a
través de un socket de control, así que solo funciona desde dentro de una
sesión kitty que tenga el remote control habilitado. 🐼

## Prerequisito

El remote control tiene que estar permitido. Revisá/habilitalo en `kitty.conf`:

```ini
allow_remote_control yes
```

O iniciá kitty con `-o allow_remote_control=yes`. Sin esto, todo comando
`kitty @ ...` falla con un error de socket/permisos.

## Comandos principales

```bash
# Tab nueva en la ventana actual
kitty @ launch --type=tab

# Ventana de OS nueva
kitty @ launch --type=os-window

# Ventana nueva en la tab actual (usa el layout activo)
kitty @ launch --type=window

# Split vertical (solo tiene efecto bajo el layout `splits`)
kitty @ launch --type=window --location=vsplit

# Split horizontal
kitty @ launch --type=window --location=hsplit

# Forzar el layout splits primero si el layout activo no es splits
kitty @ goto-layout splits
```

Cada llamada a `launch` imprime el id de la tab/ventana nueva si tiene éxito
(p. ej. `2`), que se puede usar con otros subcomandos de `kitty @`
(`focus-window`, `close-window`, `send-text`, etc.) para apuntarle con
precisión.

## Trampas

- `--location=vsplit`/`hsplit` solo tiene efecto visible bajo el layout
  `splits`. Bajo `tall`, `fat`, `grid`, etc. la ventana nueva igual se abre,
  pero la dirección del split la decide ese layout en su lugar.
- Todos los comandos `kitty @` son no-ops desde fuera de kitty (por ejemplo,
  desde un script desacoplado o una terminal distinta) — necesitan que el
  socket de un proceso kitty vivo sea alcanzable, lo cual normalmente
  significa correr desde un shell dentro de esa instancia kitty.
- `--type=window` sin `--location` simplemente usa lo que el layout actual
  haga con una ventana nueva (puede no verse como un "split" en absoluto).

## Integración en Pi

En este repo, `extensions/pandi-kitty/` envuelve estos comandos como paquete
standalone:

- comando `/kitty` para la persona usuaria (`tab`, `window`, `vsplit`, `hsplit`,
  `os-window`, `layout`, `close`, `focus`)
- tool `kitty_remote` para el modelo, con acciones `launch`, `goto-layout`,
  `close-window` y `focus-window`

Usá la extensión cuando esté disponible; reservá `kitty @ ...` directo para
casos de diagnóstico o cuando la extensión no esté instalada.
