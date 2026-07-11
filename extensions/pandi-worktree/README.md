# @pandi-coding-agent/pandi-worktree

Git worktrees te permiten tener varias ramas en carpetas separadas, sin stash ni reclonado. Esta extensión los
administra desde una sesión de Pi: listar, crear, abrir, eliminar y limpiar — con el comando interactivo `/worktree` o
con la tool `git_worktree`, así nadie tiene que escribir comandos `git worktree` a mano.

```bash
/worktree add -b feature/login my-feature
# → Se creó el worktree en /Users/you/repo/.pi/worktrees/my-feature (rama nueva feature/login) (por defecto .pi/worktrees/)
```

## Instalación

```bash
pi install npm:@pandi-coding-agent/pandi-worktree     # desde npm

pi install ./extensions/pandi-worktree             # desde este repo, global
pi install -l ./extensions/pandi-worktree          # desde este repo, local al proyecto
pi --no-extensions -e ./extensions/pandi-worktree  # prueba puntual, sin cargar nada más
```

## Qué trae

- Comando slash `/worktree` con confirmaciones, completions de subcomandos y un menú TUI interactivo para
  listar/crear/eliminar/limpiar.
- Tool `git_worktree` invocable por el modelo, con acciones explícitas y sin borrados sorpresa.
- Copia opcional de archivos gitignored (por ejemplo `node_modules`) y/o untracked hacia un worktree nuevo.
- Un hogar por defecto gitignored para worktrees nombrados con texto simple: `.pi/worktrees/<name>`.
- Un guard de un solo escritor: cuando una sesión de Pi empieza a mutar un worktree, otra sesión activa en el mismo
  worktree queda bloqueada hasta que la primera salga o su lease quede obsoleto.

## Comandos

| Comando                                                                                                      | Qué hace                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/worktree` (sin args)                                                                                       | Lista worktrees; en TUI, abre un menú interactivo (list/add/remove/prune).                                                                                                                                               |
| `/worktree list` (o `ls`)                                                                                    | Lista worktrees con sus paths absolutos.                                                                                                                                                                                 |
| `/worktree add [-b <branch>] [--detach] [--force] [--copy-ignored] [--copy-untracked] <path> [<commit-ish>]` | Agrega un worktree; `-b` crea y hace checkout de una rama nueva.                                                                                                                                                         |
| `/worktree open [las mismas flags que add] <path> [<commit-ish>]`                                            | Crea el worktree si falta, y después abre una sesión nueva de Pi en él.                                                                                                                                                  |
| `/worktree remove [--force] <path>` (o `rm`)                                                                 | Elimina un worktree (primero pide confirmación).                                                                                                                                                                         |
| `/worktree prune [--dry-run]`                                                                                | Limpia metadatos obsoletos de worktrees (siempre muestra una vista previa primero).                                                                                                                                      |
| `/worktree set [copy-ignored\|copy-untracked] [on\|off\|status]`                                             | Define o muestra los defaults de copia de la sesión.                                                                                                                                                                     |
| `git_worktree`                                                                                               | Tool del modelo: `action` (`list`/`add`/`open`/`remove`/`prune`) más `path`, `branch`, `commitish`, `detach`, `force`, `dryRun`, `copyIgnored`, `copyUntracked`; devuelve un resumen de texto y `details` estructurados. |

Ejemplo de llamada a la tool:

```json
{ "action": "add", "path": "my-feature", "branch": "feature/login" }
```

## Cómo funciona

- **`open` nunca mueve tu sesión.** El `cwd` de Pi queda fijo durante la sesión, así que `open` inicia una _sesión
  nueva_ de Pi en el worktree. Bajo Supacode abre una pestaña nueva
  (`supacode tab new -n <tabId> -i 'cd <path> && exec pi'`, con un `-n <tabId>` generado por el cliente y confirmado vía
  `tab list` para esquivar el ack TTY ausente de Supacode); si no, informa el comando `cd <path> && pi` para ejecutarlo
  manualmente. Un `/loop` o `/goal` largo en la sesión actual queda intacto.
- **Los nombres simples van a un hogar por defecto.** Un `<name>` sin separador de path cae en
  `<repo>/.pi/worktrees/<name>`, gitignored automáticamente (se escribe un `.pi/worktrees/.gitignore` con `*` la primera
  vez). Usá un path explícito (`./x`, `../x`, `/abs/x`, `~/x`) para ubicarlo en otro lugar.
- **Las opciones de copia** (`--copy-ignored`, `--copy-untracked`; params de la tool `copyIgnored`, `copyUntracked`)
  copian archivos gitignored y/o untracked desde el worktree principal a un worktree _recién creado_. La base de
  worktrees y `.git` nunca se copian, así que un worktree no se llena de otros worktrees de forma recursiva.
- **Precedencia de copia** (gana la más alta): flag explícito por llamada → default de sesión → entorno → off.
  1. Por llamada: `--copy-ignored`/`--copy-untracked` fuerzan ON; `--no-copy-ignored` /`--no-copy-untracked` fuerzan
     OFF. Los params de la tool son tri-state (`true`, `false` u omitido para seguir bajando).
  2. Default de sesión: `/worktree set copy-ignored on|off` y `/worktree set copy-untracked on|off`; `/worktree set` (o
     `… status`) reporta la resolución actual. Los defaults se reinician en cada límite de sesión.
  3. Entorno: `PI_WORKTREE_COPY_IGNORED` / `PI_WORKTREE_COPY_UNTRACKED` (tokens truthy: `1`/`true`/`on`/`yes`).

## Límites y notas de seguridad

- `git` siempre se lanza con un array argv — nunca con una cadena shell — así paths y nombres de rama no pueden inyectar
  comandos.
- El guard de un solo escritor está **apagado por defecto**. Activarlo por sesión con `/worktree set writer-guard on`, o
  al iniciar con `PI_WORKTREE_WRITER_GUARD=1` (`true`/`on`/`yes` también funcionan). Cuando está activo, guarda un lease
  con heartbeat en `.pi/worktree-writer.json` en la raíz del worktree git. Las tools de solo lectura y
  `git_worktree`/`/worktree open` siguen disponibles como escape; si una sesión se cae, el lease obsoleto se reemplaza
  solo después de un breve margen.
- `remove` pide confirmación primero; si el worktree está sucio o bloqueado, git se niega y recibís una segunda
  confirmación explícita para forzar la eliminación. La tool nunca borra por fuerza por defecto: solo descarta un
  worktree sucio con `force: true` explícito.
- `/worktree prune` (el comando slash) siempre muestra primero una vista previa equivalente a `--dry-run` antes de
  borrar algo, y confirma antes de la corrida real; la acción `prune` de la tool `git_worktree` hace una sola llamada y
  borra de inmediato salvo que el caller pase `dryRun: true`.
- Esta extensión nunca cambia el directorio de trabajo **actual** de la sesión a otro worktree; abre sesiones nuevas en
  su lugar.

## Relacionado

Para el paquete completo de extensiones y skills, instalá la raíz del repositorio.
