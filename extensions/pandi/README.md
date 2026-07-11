# @pandi-coding-agent/pandi

Pandi 🐼 es la mascota panda de Pi: agrega un encabezado de presentación temático, un indicador animado de “pensando” y
una persona suave. Es útil cuando querés que la terminal se sienta más viva sin cambiar cómo funciona Pi.

```text
/pandi face
```

Ese comando pasa el indicador al siguiente de los 5 rostros panda (se conserva entre sesiones) y muestra una muestra en
vivo, por ejemplo: `ʕ ◕ᴥ◕ ʔ Estilo ojitos (guardado).`

## Qué incluye

- Encabezado de arranque: una cara panda en block-art, con nombre y frase al lado. La paleta se adapta al tema
  claro/oscuro para que la cara siga viéndose sobre cualquier fondo de terminal.
- Indicador de trabajo animado mientras Pi piensa, con 5 estilos de cara que se recorren con `/pandi face`: `claude`
  alterna `(●  ●)` con `ʕ •ᴥ• ʔ` (más destellos `◆`), `kaomoji` `ʕ •ᴥ• ʔ`, `ojitos` `ʕ ◕ᴥ◕ ʔ`, `decidido` `ʕ •̀ᴥ•́ ʔ` y
  `gatuno` `(=◕ᴥ◕=)`. Los ojos usan colores semánticos del tema (`ojitos`→`success`, el resto→`accent`).
- Un verbo juguetón que rota en cada turno, más un guiño ocasional con la cita del meme.
- Una entrada de estado `◆ Pandi` en el pie.
- Una persona en el system prompt: mientras Pandi está activo, se agrega un bloque `<pandi_persona>` (tono suave/zen;
  carácter creativo, didáctico y conciso; firma 🐼 ocasional). `/pandi off` lo quita y restaura la persona por defecto.

## Instalación

Desde npm:

```bash
pi install npm:@pandi-coding-agent/pandi
```

Desde este repositorio:

```bash
pi install ./extensions/pandi          # global (tu usuario)
pi install -l ./extensions/pandi       # local al proyecto
pi --no-extensions -e ./extensions/pandi   # prueba única, sin cargar nada más
```

## Comandos

| Comando       | Qué hace                                                                                     |
| ------------- | -------------------------------------------------------------------------------------------- |
| `/pandi`      | Muestra el estado y un saludo (sin argumentos, en una UI interactiva, abre un menú pequeño). |
| `/pandi art`  | Muestra u oculta el encabezado panda.                                                        |
| `/pandi face` | Pasa al siguiente de los 5 estilos de cara del indicador (se conserva entre sesiones).       |
| `/pandi off`  | Apaga Pandi y restaura el encabezado, el spinner y la persona por defecto.                   |
| `/pandi on`   | Vuelve a encender Pandi.                                                                     |

## Detalles

El estilo de cara elegido con `/pandi face` se guarda en `pandi-style.local.json` junto a la extensión (ignorado por
git).

## Relacionado

Si querés el paquete completo de extensiones y skills, instalá la raíz del repositorio.
