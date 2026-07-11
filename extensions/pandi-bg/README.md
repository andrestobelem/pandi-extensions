# @pandi-coding-agent/pandi-bg

`/bg` ejecuta un comando de shell en segundo plano dentro de una sesión de Pi, así que una compilación larga, una suite
de tests o un servidor no te bloquean el chat. Cada job tiene sus propios logs y un estado que podés consultar después.
Es el hermano chico, humano y no reanudable de los background runs de `dynamic_workflow`: vive en memoria; si necesitás
orquestación agéntica que sobreviva a un reinicio, usá `dynamic_workflow`.

## Probar

```bash
/bg start npm test
# Job en segundo plano bg-lz3k2p1-a1b2c3d4 iniciado.
# Artifacts: /path/to/artifacts/bg-lz3k2p1-a1b2c3d4
# Estado: /bg status bg-lz3k2p1-a1b2c3d4
# Logs: /bg logs bg-lz3k2p1-a1b2c3d4

/bg status bg-lz3k2p1-a1b2c3d4
/bg logs bg-lz3k2p1-a1b2c3d4
```

## Instalar

Desde npm:

```bash
pi install npm:@pandi-coding-agent/pandi-bg
```

Desde este repositorio:

```bash
pi install ./extensions/pandi-bg          # global (tu usuario)
pi install -l ./extensions/pandi-bg       # local al proyecto
pi --no-extensions -e ./extensions/pandi-bg   # prueba puntual, sin cargar nada más
```

## Qué obtenés

- Comandos slash para iniciar, inspeccionar, cancelar y limpiar jobs locales en segundo plano. No se registra ningún
  tool LLM `background_job`.
- Artifacts por job bajo `.pi/bg/runs/<jobId>/`: `job.json`, `status.json`, `events.jsonl`, `stdout.log`, `stderr.log`,
  `combined.log`.
- Un journal acotado del ciclo de vida (`/bg events`) que explica _por qué_ un job terminó
  `failed`/`cancelled`/`interrupted`; `status.json` solo no alcanza.
- Limpieza segura de disco (`/bg delete`, `/bg prune`) que solo borra jobs terminados y deja una línea de auditoría.

## Comandos

| Comando                 | Qué hace                                                                              |
| ----------------------- | ------------------------------------------------------------------------------------- |
| `/bg preview <command>` | Vista previa de un job en segundo plano sin ejecutarlo (alias deprecado: `/bg plan`). |
| `/bg start <command>`   | Inicia un job en segundo plano en un proyecto confiable.                              |
| `/bg list`              | Lista los jobs conocidos.                                                             |
| `/bg status <jobId>`    | Inspecciona un job, incluyendo una prueba de liveness/identidad.                      |
| `/bg logs <jobId>`      | Lee logs acotados y truncados.                                                        |
| `/bg events <jobId>`    | Lee el journal acotado del ciclo de vida (`events.jsonl`).                            |
| `/bg cancel <jobId>`    | Cancela un job propiedad de este proceso de Pi (o un huérfano verificado).            |
| `/bg delete <jobId>`    | Borra los artifacts de un job terminado.                                              |
| `/bg prune [--yes]`     | Muestra qué jobs terminados pueden borrarse (dry-run); `--yes` los elimina.           |

## Cómo funciona

- `/bg start` solo funciona en sesiones TUI/RPC persistentes y en proyectos confiables; los proyectos no confiables se
  rechazan antes de ejecutar o escribir nada.
- Los comandos mutantes (`start`, `cancel`, `delete`, `prune`) se bloquean mientras `/plan` está activo.
- Los jobs corren como grupos de procesos detached, salvo en Windows, donde el child no se crea detached. `job.json` y
  `status.json` se escriben con archivo temporal + rename atómico; los logs son append-only.
- Los artifacts locales del proyecto viven en `.pi/bg/runs/<jobId>/`. Existe un fallback global de solo lectura en
  `~/.pi/agent/bg/runs/<cwd-hash>/<jobId>/`.
- No hay runner de Supacode, daemon, rehidratación automática ni panel de `/bg`.

## Límites y seguridad

- **Artifacts en texto plano.** El comando (`job.json`) y sus logs de salida se guardan sin redacción. Evitá pasar
  secretos en la línea de comando; recuperá espacio con `/bg prune` o `/bg delete`.
- **El trust gate protege contexto y artifacts, no el comando.** Igual que el resto de `Pi` exec, `/bg start` ejecuta lo
  que escribas vía `shell:true`.
- **Los jobs no sobreviven a un restart de Pi.** Quedan en memoria del proceso de Pi que los inició; `/bg cancel`
  rechaza jobs que no estén activos en la sesión actual (salvo huérfanos verificados, abajo).
- Un job detached que sigue corriendo queda huérfano después de un restart. Detené un huérfano **verificado** con
  `/bg cancel`; si no, usá herramientas del SO (`kill`/`pkill`/`taskkill`).
- El borrado solo aplica a jobs terminados: el estado vivo se rederiva en el momento del prune, así que un job en
  ejecución, activo en sesión o vivo verificado por identidad nunca se borra. La limpieza actúa solo sobre el almacén
  local del proyecto, es segura frente a symlinks/path traversal (un symlink interno se deslinkea, no se sigue) y agrega
  una línea en `.pi/bg/runs/.audit.jsonl` por cada remoción.

## Detalles

### Disponibilidad y reutilización de pid

- Para jobs que no pertenecen a la sesión actual, `/bg status` y `/bg list` proyectan el estado en tiempo de lectura
  probando el pid registrado (signal-0, no se envía señal): `orphaned` (pid vivo), `interrupted` (pid muerto) o `stale`
  (no hay pid para probar).
- Para evitar reutilización de pid, cada job registra una **identidad de inicio** (`startId`: `starttime` de Linux
  `/proc`; `ps -o lstart=` en macOS/BSD; ausente en Windows).
- `/bg status` hace una sola prueba de identidad: un pid vivo con identidad coincidente es un `orphaned` verificado
  (`identity: verified`); un pid vivo con identidad distinta significa que el pid fue reutilizado y se informa como
  `interrupted` (`interruptedCause: pid-reused`); una identidad ilegible queda como `orphaned` de mejor esfuerzo con una
  sugerencia de verificación antes de matar.
- `/bg list` se queda solo con la prueba barata signal-0 (sin subprocess por job), así que puede mostrar un `orphaned`
  de mejor esfuerzo que `/bg status` refinaría.

### Semántica de cancelación

- `/bg cancel` siempre actúa sobre jobs propiedad del proceso actual de Pi.
- Para un job persistido por otra sesión, envía señal al process group **solo** cuando la identidad de inicio registrada
  prueba que el pid vivo sigue siendo el proceso de ese job: manda `SIGTERM` al grupo y reescribe el job como
  `cancelled` (reason `cancel-verified-orphan`).
- Un pid reutilizado, o uno cuya identidad no puede leerse, se rechaza y nunca recibe señal: detenelo con herramientas
  del SO.

### Auto-reparación al iniciar sesión

- Al iniciar sesión (solo sesiones persistentes y confiables), un job local del proyecto persistido como
  `running`/`starting` se reescribe atómicamente a `interrupted` en disco cuando su pid está muerto **o** vivo pero
  reutilizado (identidad de inicio distinta).
- Terminalizar solo con evidencia positiva (pid muerto o reutilización probada) mantiene segura la reescritura; los jobs
  vivos verificados o no comprobables se dejan intactos (siguen proyectándose como `orphaned`/`stale`).

## Relacionado

Para instalar el paquete completo de extensiones y skills, instalá la raíz del repositorio.
