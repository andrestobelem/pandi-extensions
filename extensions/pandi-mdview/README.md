# @pandi-coding-agent/pandi-mdview

Leer un `.md` suele sacar al usuario del terminal hacia un editor o una pestaña del navegador. `pandi-mdview` agrega un
visor de Markdown desplazable dentro de la TUI de Pi, más una herramienta `view_markdown` para que el agente pueda abrir
un archivo por vos (por ejemplo, después de escribir un informe). Usalo cuando tú o el modelo necesiten leer Markdown
sin cortar el flujo.

```text
/mdview docs/scaffolds/map-reduce.md
```

Eso abre el archivo en el mismo lugar, con `↑/↓` o `j/k` para desplazar, `PgUp/PgDn` para paginar y `q`/`Esc` para
cerrar. Fuera de una TUI (por ejemplo `--print`), solo imprime el Markdown crudo en la terminal.

## Instalación

Desde npm:

```bash
pi install npm:@pandi-coding-agent/pandi-mdview
```

Desde este repositorio:

```bash
pi install ./extensions/pandi-mdview          # global (tu usuario)
pi install -l ./extensions/pandi-mdview       # local al proyecto
pi --no-extensions -e ./extensions/pandi-mdview   # prueba puntual, sin cargar nada más
```

## Referencia

| Comando          | Qué hace                                                                                                                                                                                     |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/mdview <path>` | Abre un archivo Markdown en la TUI de Pi con controles de scroll (`↑/↓` o `j/k`, `PgUp/PgDn`, `q`/`Esc` para cerrar). Las rutas pueden ser relativas al cwd, expandidas con `~` o absolutas. |
| `view_markdown`  | Tool del modelo: usa el mismo visor y la puede invocar el agente (por ejemplo, "abrí README.md"); en modos no interactivos devuelve el contenido Markdown crudo.                             |

## Límites y notas de seguridad

- Se rechazan archivos de más de 2 MB: parsear un archivo enorme bloquearía el loop de eventos de la TUI.
- En modos sin TUI, `/mdview` imprime el Markdown en la terminal. Bajo `--print`/`--json`, pi reserva stdout real para
  la respuesta del modelo y manda la salida de la extensión a stderr, así que el contenido **no** se puede redirigir a
  un archivo (`pi /mdview f.md > out.md` no captura nada — usá `cat` para volcar Markdown crudo).

## Relacionado

Para instalar el paquete completo de extensiones y skills, instalá la raíz del repositorio.
