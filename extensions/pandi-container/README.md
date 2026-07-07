# @pandi-coding-agent/pandi-container

Ejecutá comandos Linux en una micro-VM aislada en lugar de hacerlo directo sobre tu Mac. Esta extensión envuelve [Apple `container`](https://github.com/apple/container) para que una sesión de Pi pueda crear sandboxes Linux desechables o persistentes: útil para comandos no confiables, herramientas puntuales o cualquier cosa que no quieras tocar en el filesystem del host. Las dos superficies comparten el mismo spawn con argv solamente (nunca un string de shell), así que las referencias de imagen, los nombres de máquina y los comandos no pueden inyectar shell: `/container` (interactivo, humano) y `container_sandbox` (acciones explícitas, invocable por el modelo, sin borrados sorpresivos).

## Inicio rápido

```bash
/container create alpine:latest dev --size small   # máquina Linux pequeña: 2 CPU / 1G
/container run dev -- uname -a                      # ejecuta un comando dentro de ella
/container remove dev                               # limpiá cuando termines
```

## Instalación

Desde npm:

```bash
pi install npm:@pandi-coding-agent/pandi-container
```

Desde este repositorio:

```bash
pi install ./extensions/pandi-container             # global (tu usuario)
pi install -l ./extensions/pandi-container          # local al proyecto
pi --no-extensions -e ./extensions/pandi-container   # prueba puntual, sin cargar nada más
```

## Comandos

| Comando | Qué hace |
| --- | --- |
| `/container` | Sin argumentos abre un selector interactivo de acciones (si no hay TUI, cae a `status`). |
| `/container status` | Muestra el resumen del subsistema y las máquinas. |
| `/container list` | Lista las máquinas de contenedor. |
| `/container create <image> [name] [--size <tier>]` | Crea una máquina (p. ej. `alpine:latest dev --size small`). |
| `/container run <machine> -- <cmd...>` | Ejecuta un comando dentro de una máquina, p. ej. `/container run dev -- uname -a`. |
| `/container stop [name]` | Detiene una máquina (la default si se omite). |
| `/container remove <name>` | Elimina una máquina; pide confirmación en la TUI antes. |
| `container_sandbox` | Tool para el modelo: mismas acciones (`status`, `list`, `create`, `run`, `stop`, `remove`) — ver abajo. |

## Cómo funciona

La tool `container_sandbox` recibe una acción (`action`) más:

| Parámetro | Significado |
| --- | --- |
| `name` | Nombre de la máquina (create/stop/remove, o destino de run). |
| `image` | Imagen OCI (create, o run efímero), por ejemplo `alpine:latest`. |
| `command` | Array argv para `run`, por ejemplo `["uname", "-a"]`. |
| `machine` | Máquina existente donde ejecutar (si no, se usa un contenedor efímero vía `image`). |
| `tier` | Preset de tamaño con nombre para `create` o `run` efímero — ver [Niveles de tamaño](#niveles-de-tamaño). |
| `workdir` | Solo para `run`: directorio de trabajo dentro del contenedor. |
| `cpus`, `memory` | Para `create`, o para `run` efímero (`image`, no `machine`): los valores explícitos pisan `tier`. Se ignoran cuando `run` apunta a una `machine` existente. |
| `homeMount` (`ro`\|`rw`\|`none`), `setDefault` | Solo para `create`. |
| `force` | Requerido para `remove`. |

Devuelve un resumen en texto más `details` estructurados (la lista de máquinas parseada, el nombre creado, el destino/exit code del run, etc.).

### Máquina persistente vs. contenedor efímero

| Usá... | Cuándo | Parámetros de `run` |
| --- | --- | --- |
| una máquina persistente | la sandbox debe sobrevivir entre comandos; refleja tu home/cwd de macOS dentro de Linux (editás en macOS, ejecutás en Linux) | `machine` (creada antes con `create`) |
| un contenedor efímero | un comando de una sola vez; equivalente a `container run --rm`, se elimina automáticamente al terminar (solo en la tool — `/container run` apunta a una máquina) | `image` |

```jsonc
// ejecuta dentro de una máquina persistente existente
{ "action": "run", "machine": "dev", "command": ["uname", "-sr"] }

// ejecuta en un contenedor efímero nuevo (se elimina al terminar)
{ "action": "run", "image": "alpine:latest", "command": ["echo", "hello"] }
```

## Niveles de tamaño

Apple `container` v1.0.0 define `machine create --memory` por defecto en **la mitad de la RAM del host** (por ejemplo, ~18G en una máquina de 36GB) y deja sin documentar el valor por defecto de `--cpus` (`container machine create --help`); los valores por defecto de `run` efímero para `-c`/`-m` tampoco están documentados. La mitad de la RAM del host es mucho para una sandbox, así que la extensión trae presets con nombre:

| Nivel | CPUs | Memoria | Válido para |
| --- | --- | --- | --- |
| `micro` | 1 | 256M | solo `run` efímero |
| `tiny` | 2 | 512M | solo `run` efímero |
| `small` | 2 | 1G | `create` + `run` efímero |
| `medium` | 4 | 2G | `create` + `run` efímero |
| `large` | 8 | 4G | `create` + `run` efímero |

La escalera arranca en `micro` con 256M y duplica la memoria en cada nivel. La stack de virtualización de Apple impone un mínimo duro de **200 MiB** por VM (`minimum memory amount allowed is 200 MiB`); se verificó un `npm i -g @earendil-works/pi-coding-agent` real y `pi --version` dentro de una VM de 200M con ~114MB de RSS, así que 256M alcanza cómodo para cargas chicas de Node/CLI.

- **Opt-in**: sin `tier` y sin `cpus`/`memory` explícitos, no se emite ninguna flag y la CLI conserva sus defaults (igual que antes de los niveles).
- **Precedencia**: `cpus`/`memory` explícitos pisan al `tier`, campo por campo.
- **Alcance**: los niveles aplican a `create` (máquina) y a `run` efímero por imagen solamente. No aplican a `run` dentro de una máquina existente: sus recursos quedan fijados al crearla con la CLI upstream.
- **Dos pisos distintos de la CLI** (ambos medidos en v1.0.0): `run` efímero baja hasta **200 MiB**, pero `machine create` exige **al menos 1G** (error real: `invalid memory value '256mb'. Must be greater than 1gb`). La extensión rechaza `micro`/`tiny` para `create` con un error acotado antes de lanzar nada.

```jsonc
// tool: crea una máquina pequeña
{ "action": "create", "image": "alpine:latest", "name": "dev", "tier": "small" }

// tool: run efímero con nivel (emite --cpus 2 --memory 1G)
{ "action": "run", "image": "alpine:latest", "tier": "small", "command": ["uname", "-a"] }
```

Equivalente en comando: `/container create alpine:latest dev --size small` (alias `--tier`).

## Limitaciones y notas de seguridad

- Apple `container` requiere **macOS en Apple Silicon** (arm64); macOS 26 está recomendado. En un host no compatible, la extensión devuelve un solo mensaje acotado en vez de fallar de forma opaca.
- Antes de usarla hay que preparar la CLI (`brew install container`), un kernel configurado (`container system kernel set --recommended`) y un subsistema iniciado (`container system start`).
- La tool nunca borra por defecto: `remove` solo avanza cuando se pasa `force: true` de forma explícita. El comando `/container remove` confirma primero en la TUI.
- Los comandos que corren dentro de la VM se pasan como array argv: no hay interpolación de shell en el host.
- Cada llamada a la CLI de Apple `container` tiene un timeout de 120s. Se puede sobreescribir con `PI_CONTAINER_TIMEOUT_MS` para pulls lentos o comandos largos dentro del sandbox.

## Relacionado

Para instalar todo el paquete de extensiones y skills, instalá en su lugar la raíz del repositorio.
